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
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ControlClient } from './client.js';
import { buildTools } from './tools.js';
import { ApiError } from './errors.js';
import { validateArguments } from './validate.js';

const PROTOCOL_VERSION = '2025-06-18';

/*
 * Until 0.4.0 this server called a workspace an "environment" — in six tool
 * names and in the argument every one of them takes — while the CLI, the
 * manual and the dashboard had always called it a workspace. The manual had
 * to carry a line saying the two words named the same object, which is a
 * documentation fix for a naming bug. The tools are renamed; these are the
 * old names, still dispatched and deliberately NOT advertised in
 * `tools/list`, because a client that cached the old list or an agent
 * quoting an older README would otherwise call a tool that vanished.
 */
const LEGACY_TOOL_NAMES = {
  create_environment: 'create_workspace',
  list_environments: 'list_workspaces',
  get_environment: 'get_workspace',
  checkpoint_environment: 'checkpoint_workspace',
  pause_environment: 'pause_workspace',
  delete_environment: 'delete_workspace',
};

/**
 * Accept `environment` where a tool now takes `workspace`.
 *
 * An explicit `workspace` always wins: a caller that sends both means the one
 * it named under the current spelling, and silently preferring the legacy key
 * would send the command to a different workspace than the one it asked for.
 * The loser is DROPPED rather than passed through — no tool declares an
 * `environment` property any more, so leaving it would make the legacy
 * spelling fail schema validation on the way to the handler that supports it.
 */
function withLegacyArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (args.environment === undefined) return args;
  const { environment, ...rest } = args;
  return args.workspace !== undefined ? rest : { ...rest, workspace: environment };
}

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
                    `This reachpad connection acts as ${account}. Workspaces belong to that ` +
                    `account and no other. If someone expects to see workspaces that are not ` +
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
          const requested = params?.name;
          const tool = byName.get(requested) ?? byName.get(LEGACY_TOOL_NAMES[requested]);
          if (!tool) {
            // An unknown tool is a protocol error, not a tool failure: the
            // caller asked for something this server never advertised.
            return error(id, -32602, `unknown tool: ${requested}`);
          }
          // The schema is a promise this server makes in `tools/list`, so it
          // is checked here rather than trusted. Same code as `unknown tool`
          // above and for the same reason: the caller sent something this
          // server never said it would accept, which is a protocol error and
          // not a tool that ran and failed.
          const args = withLegacyArguments(params?.arguments ?? {});
          const problems = validateArguments(args, tool.inputSchema);
          if (problems.length) {
            return error(id, -32602, `invalid arguments for ${tool.name}: ${problems.join('; ')}`);
          }
          try {
            const text = await tool.handler(args);
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
    // Authenticated by DEFAULT. An unset token used to mean "let everyone in"
    // with a warning on stderr nobody reads, on a port every other process and
    // every other user on the machine can reach — and `run_command` is one
    // POST behind it. So a missing token is now MINTED and printed rather than
    // treated as consent, and the open endpoint is a thing someone asks for.
    const configured = process.env.REACHPAD_MCP_HTTP_TOKEN;
    const anonymous = process.env.REACHPAD_MCP_HTTP_NO_AUTH === '1';
    const token = anonymous ? undefined : configured || randomBytes(32).toString('base64url');
    const http = await listen(createServer(), {
      port: Number(port),
      host: process.env.REACHPAD_MCP_HTTP_HOST || '127.0.0.1',
      token,
      allowAnonymous: anonymous,
      allowedOrigins: (process.env.REACHPAD_MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    });
    const { address, port: bound } = http.address();
    process.stderr.write(`reachpad mcp: streamable http on http://${address}:${bound}\n`);
    if (anonymous) {
      process.stderr.write(
        'reachpad mcp: WARNING — REACHPAD_MCP_HTTP_NO_AUTH=1, every caller that can reach this port is authorized\n',
      );
    } else if (!configured) {
      // Printed, because a token nobody can read is the same as a closed port.
      process.stderr.write(
        `reachpad mcp: no REACHPAD_MCP_HTTP_TOKEN was set, so this one was generated for this run:\n\n` +
          `    Authorization: Bearer ${token}\n\n` +
          `reachpad mcp: it changes every restart. Set REACHPAD_MCP_HTTP_TOKEN to pin it, or\n` +
          `reachpad mcp: REACHPAD_MCP_HTTP_NO_AUTH=1 to serve with no authentication at all.\n`,
      );
    }
  } else {
    serveStdio(createServer());
  }
}
