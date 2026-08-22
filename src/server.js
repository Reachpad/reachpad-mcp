#!/usr/bin/env node
/**
 * MCP server over stdio: newline-delimited JSON-RPC 2.0.
 *
 * The REST API is canonical (ADR-0066); this process only translates. It holds
 * no state a restart cannot rebuild, and it never reaches past `/v1` — there
 * is no privileged interface (I6).
 *
 * Configuration, all from the environment, names only ever logged:
 *   REACHPAD_ENDPOINT        the one host (ADR-0040). Default m1.reachpad.dev.
 *   REACHPAD_OPERATOR_TOKEN  rpop1.… — exchanged for identity tokens.
 *   REACHPAD_API_KEY         rpak1.… — optional; used for run_command.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ControlClient } from './client.js';
import { buildTools } from './tools.js';
import { ApiError } from './errors.js';

const PROTOCOL_VERSION = '2025-06-18';

/*
 * The version is read from package.json rather than written here twice. It had
 * drifted to three different answers: this literal said 0.1.0, package.json
 * said 0.2.0 and the latest on npm was 0.1.5, so every client was told 0.1.0
 * no matter which build it was talking to. package.json ships in the tarball
 * whatever the files list says, so this resolves in the published package too.
 */
const SERVER_INFO = {
  name: 'reachpad',
  version: JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version,
};

export function createServer({ env = process.env, fetchImpl } = {}) {
  const client = new ControlClient({
    endpoint: env.REACHPAD_ENDPOINT || 'm1.reachpad.dev',
    operatorToken: env.REACHPAD_OPERATOR_TOKEN,
    identityCredential: env.REACHPAD_IDENTITY_CREDENTIAL,
    apiKey: env.REACHPAD_API_KEY,
    idpAssertion: env.REACHPAD_IDP_ASSERTION,
    accountLabel: env.REACHPAD_ACCOUNT_LABEL?.trim(),
    userId: env.REACHPAD_USER_ID,
    principalId: env.REACHPAD_PRINCIPAL_ID,
    fetch: fetchImpl,
  });
  const tools = buildTools(client);
  // Which account this connection acts as. Nothing else tells anyone: a person
  // who authorized with the wrong email gets a working connection to an empty
  // account, and silence makes that look like lost work rather than a wrong
  // login. Saying it once, up front, is the whole fix.
  const account = env.REACHPAD_ACCOUNT_LABEL?.trim();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  /** @returns {object|null} a response, or null for a notification. */
  async function handle(message) {
    const { id, method, params } = message ?? {};
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize':
          return reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            ...(account
              ? {
                  instructions:
                    `This reachpad connection acts as ${account}. Environments belong to that ` +
                    `account and no other. If someone expects to see environments that are not ` +
                    `listed, say which account is connected before anything else — the usual ` +
                    `cause is authorizing with a different email than the one they use for reachpad.`,
                }
              : {}),
          });

        case 'notifications/initialized':
          return null;

        case 'ping':
          return reply(id, {});

        case 'tools/list':
          // `title` and `annotations` are not decoration: a client shows the
          // title to a human approving a call, and the hints tell it which
          // calls need approval at all. Anthropic's connector review flags a
          // tool that carries neither, and it is right to — an agent deciding
          // whether `run_command` is safe to retry has nothing else to read.
          return reply(id, {
            tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
              name,
              title,
              description,
              inputSchema,
              annotations,
            })),
          });

        case 'tools/call': {
          const tool = byName.get(params?.name);
          if (!tool) {
            // An unknown tool is a protocol error, not a tool failure: the
            // caller asked for something this server never advertised.
            return error(id, -32602, `unknown tool: ${params?.name}`);
          }
          try {
            const text = await tool.handler(params.arguments ?? {});
            return reply(id, { content: [{ type: 'text', text }], isError: false });
          } catch (err) {
            // A tool that refused is a RESULT, not a transport error — the
            // model must see the refusal and its remedy, and be able to act.
            return reply(id, {
              content: [{ type: 'text', text: describe(err) }],
              isError: true,
            });
          }
        }

        default:
          if (isNotification) return null;
          return error(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return error(id, -32603, describe(err));
    }
  }

  return { handle, tools, client };
}

function describe(err) {
  if (err instanceof ApiError) return err.message;
  return err?.message ? String(err.message) : String(err);
}

function reply(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Wire the server to stdio. Split out so tests can drive `handle` directly. */
export function serveStdio(server, input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      output.write(`${JSON.stringify(error(null, -32700, 'parse error'))}\n`);
      return;
    }
    server
      .handle(message)
      .then((response) => {
        if (response) output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err) => {
        output.write(`${JSON.stringify(error(message?.id ?? null, -32603, describe(err)))}\n`);
      });
  });
  return lines;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const port = process.env.REACHPAD_MCP_HTTP_PORT;
  if (port) {
    // The remote shape. Loopback by default: this process bridges to a control
    // plane with the caller's credentials, so binding it to the world is a
    // decision someone makes on purpose, in front of a proxy that terminates
    // TLS and does the authorization.
    const { listen } = await import('./http.js');
    const http = await listen(createServer(), {
      port: Number(port),
      host: process.env.REACHPAD_MCP_HTTP_HOST || '127.0.0.1',
      token: process.env.REACHPAD_MCP_HTTP_TOKEN,
      allowedOrigins: (process.env.REACHPAD_MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    });
    const { address, port: bound } = http.address();
    process.stderr.write(`reachpad mcp: streamable http on http://${address}:${bound}\n`);
    if (!process.env.REACHPAD_MCP_HTTP_TOKEN) {
      process.stderr.write(
        'reachpad mcp: WARNING — no REACHPAD_MCP_HTTP_TOKEN, every caller that can reach this port is authorized\n',
      );
    }
  } else {
    serveStdio(createServer());
  }
}
