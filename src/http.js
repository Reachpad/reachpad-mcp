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
 *
 * What it does NOT decline to do any more is serve without a token. The guard
 * here used to read `if (token && !presentsToken(...))`, so an absent token
 * short-circuited it and every caller that could reach the port was
 * authorized — on a process that bridges to a control plane with the user's
 * credentials, where `run_command` is one POST away. No token is now a
 * refusal at construction, and serving open is an affirmative argument
 * somebody passes on purpose.
 */

import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, payloadProblem } from './jsonrpc.js';

/**
 * @param {{handle: (payload: unknown) => Promise<object|null>}} server
 * @param {{token?: string, allowedOrigins?: string[], allowAnonymous?: boolean}} options
 */
export function createHttpHandler(server, options = {}) {
  const { token, allowedOrigins = [], allowAnonymous = false } = options;

  // At construction, not per request: an endpoint that will authorize
  // everybody should never reach `listen()` by accident, and a startup failure
  // is the one error a caller cannot miss.
  if (!token && !allowAnonymous) {
    throw new Error(
      'refusing to serve an unauthenticated MCP endpoint: pass a token, or pass allowAnonymous: true to mean it',
    );
  }

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
      // `token` is always set unless the caller asked for an open endpoint by
      // name; see the construction check above.
      // A challenge, so a client knows what to present rather than guessing.
      return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
    }

    // Stateless does not mean versionless. After initialization an HTTP MCP
    // client names the negotiated revision on every request; an absent header
    // remains accepted for the protocol's backwards-compatible fallback, but
    // an explicit value this server cannot speak must fail closed.
    const protocolVersion = req.headers['mcp-protocol-version'];
    if (protocolVersion !== undefined && protocolVersion !== PROTOCOL_VERSION) {
      return send(400, rpcError(-32600, 'unsupported MCP protocol version'));
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

    // A malformed request or a batch is an HTTP 400 as well as JSON-RPC
    // -32600. MCP 2025-06-18 removed JSON-RPC batching entirely.
    const problem = payloadProblem(message);
    if (problem) return send(400, rpcError(-32600, problem));

    const response = await server.handle(message);
    if (!response) return send(202, null);
    return send(200, response);
  };
}

function rpcError(code, message) {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
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
      if (size > MAX_MESSAGE_BYTES) {
        refused = true;
        chunks.length = 0;
        reject(new Error(`body exceeds ${MAX_MESSAGE_BYTES} bytes`));
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
