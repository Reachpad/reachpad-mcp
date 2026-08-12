/**
 * Streamable HTTP transport (MCP 2025-03-26 and later) — the same `handle()`
 * the stdio entry point uses, reached by a URL instead of a pipe. This is what
 * a remote connector talks to; stdio is what a developer's own process talks
 * to. One implementation, two wires.
 *
 * What this deliberately does NOT do:
 *
 * - **No server-initiated stream.** GET on the endpoint answers 405. Every
 *   tool here is request/response; the spec allows a server to decline the
 *   SSE channel and nothing in this surface needs one, so opening one would be
 *   a connection to keep alive for no traffic.
 * - **No sessions.** `Mcp-Session-Id` is optional and this server holds
 *   nothing across calls that a restart could not rebuild — the identity token
 *   cache is keyed by the credential, not by a client.
 * - **No credential of its own.** Whatever authorizes the HTTP request is what
 *   authorizes reachpad. Until the OAuth work in ADR-0066 §3 lands that is a
 *   bearer token compared in constant time; afterwards it is the OAuth token,
 *   and this is the layer that changes.
 */

import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 1024 * 1024; // controld's own control-plane body cap.

/**
 * @param {{handle: (message: object) => Promise<object|null>}} server
 * @param {{token?: string, allowedOrigins?: string[]}} options
 */
export function createHttpHandler(server, options = {}) {
  const { token, allowedOrigins = [] } = options;

  return async function handler(req, res) {
    const send = (status, payload, headers = {}) => {
      const body = payload === null ? '' : JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...headers,
      });
      res.end(body);
    };

    // DNS rebinding is the named attack on a local HTTP MCP endpoint: a page
    // in the user's browser resolving a hostname to 127.0.0.1 and POSTing to
    // it. A browser cannot forge Origin, so refusing an unlisted one closes it.
    // No Origin at all is a non-browser client, which is the normal case.
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      return send(403, { error: 'origin_not_allowed' });
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // No server-initiated stream and no session to end.
      return send(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    }
    if (req.method !== 'POST') {
      return send(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    }

    if (token && !presentsToken(req, token)) {
      // A challenge, so a client knows what to present rather than guessing.
      return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      // The client is still uploading, so the socket cannot simply be
      // destroyed — an RST here races the response and the caller sees a
      // network error rather than the reason it was refused. Announce the
      // close, answer, and drop the connection once the answer has flushed.
      res.on('finish', () => req.destroy());
      return send(413, { error: 'payload_too_large', detail: err.message }, { connection: 'close' });
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }

    // A JSON-RPC batch is an array. Answer each, drop the nulls that
    // notifications produce, and return 202 when nothing is left to say.
    if (Array.isArray(message)) {
      const responses = (await Promise.all(message.map((one) => server.handle(one)))).filter(Boolean);
      return responses.length ? send(200, responses) : send(202, null);
    }

    const response = await server.handle(message);
    if (!response) return send(202, null);
    return send(200, response);
  };
}

/** Constant-time bearer comparison; a length mismatch is still a mismatch. */
function presentsToken(req, expected) {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return; // keep draining; the answer is already decided
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        chunks.length = 0;
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Bind the handler to a port. Returns the node server, already listening. */
export async function listen(server, { port = 0, host = '127.0.0.1', ...options } = {}) {
  const handler = createHttpHandler(server, options);
  const http = createHttpServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal' }));
    });
  });
  await new Promise((resolve) => http.listen(port, host, resolve));
  return http;
}
