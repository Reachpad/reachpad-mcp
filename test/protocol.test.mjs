/**
 * End to end over the real transport: a CHILD PROCESS running the shipped
 * server, spoken to in newline-delimited JSON-RPC on stdin/stdout, against a
 * stub controld on a real socket. Nothing here imports the server's internals,
 * so the thing under test is the thing that ships.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startStubControld } from './lib/stub-controld.mjs';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));

class McpClient {
  constructor(endpoint, extraEnv = {}) {
    this.child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        REACHPAD_ENDPOINT: endpoint,
        REACHPAD_OPERATOR_TOKEN: 'rpop1.test.secret',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.pending = new Map();
    this.nextId = 1;
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000).unref();
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async call(name, args = {}) {
    const response = await this.send('tools/call', { name, arguments: args });
    assert.ok(response.result, `tools/call ${name} returned an error frame: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function withServer(options, body) {
  const stub = await startStubControld(options);
  const client = new McpClient(stub.endpoint, options.env);
  try {
    await body(client, stub);
  } finally {
    client.close();
    await stub.close();
  }
}

test('the handshake reports the protocol version and the tool surface', async () => {
  await withServer({}, async (client) => {
    const init = await client.send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'reachpad');
    assert.ok(init.result.capabilities.tools);

    client.notify('notifications/initialized');

    const listed = await client.send('tools/list');
    const names = listed.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'checkpoint_environment',
      'create_environment',
      'delete_environment',
      'get_credit_balance',
      'get_environment',
      'list_environments',
      'run_command',
    ]);
    // Every tool must carry a schema an LLM can fill in without guessing, and
    // a title plus behaviour hints. Those are a DIRECTORY REQUIREMENT —
    // Anthropic's connector review flags tools missing them — and they are
    // what a client reads to decide whether a call needs human approval.
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.ok(tool.title, `${tool.name} needs a title`);
      assert.ok(tool.annotations, `${tool.name} needs behaviour annotations`);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(
          typeof tool.annotations[hint],
          'boolean',
          `${tool.name}.annotations.${hint} must be stated, not left to a guess`,
        );
      }
    }

    // The two that decide whether a client asks a human first. Stated as
    // assertions because getting either backwards is silent: a destructive
    // tool marked read-only is approved without being read.
    const byName = Object.fromEntries(listed.result.tools.map((t) => [t.name, t]));
    assert.equal(byName.run_command.annotations.readOnlyHint, false);
    assert.equal(byName.run_command.annotations.destructiveHint, true);
    assert.equal(byName.list_environments.annotations.readOnlyHint, true);
    assert.equal(byName.delete_environment.annotations.destructiveHint, true);
    assert.ok(
      !byName.create_environment.inputSchema.required?.includes('name'),
      'creating an environment must not make the caller invent a name',
    );
  });
});

test('the whole arc: create, run, checkpoint, list, delete', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

    const created = await client.call('create_environment', {});
    assert.match(
      created.content[0].text,
      /environment ws-1 created \(name: workspace-000000000001\)/,
    );
    assert.equal(created.isError, false);
    const createCall = stub.state.calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/workspaces',
    );
    assert.equal(createCall.body.name, undefined, 'MCP must let the server generate the name');

    const ran = await client.call('run_command', {
      environment: 'ws-1',
      argv: ['/bin/sh', '-lc', 'echo hi'],
    });
    assert.match(ran.content[0].text, /exit 0 after 11 ms/);
    assert.match(ran.content[0].text, /hello from the guest/);

    const forked = await client.call('checkpoint_environment', { environment: 'ws-1', name: 'try-b' });
    assert.match(forked.content[0].text, /forked ws-1 → ws-2 \(try-b\)/);

    const listed = await client.call('list_environments');
    assert.match(listed.content[0].text, /ws-1\s+workspace-000000000001\s+1 fork/);

    const deleted = await client.call('delete_environment', { environment: 'ws-1' });
    assert.match(deleted.content[0].text, /archived; its history is intact/);

    // I6: the identity token is exchanged once and reused, not minted per call.
    const sessions = stub.state.calls.filter((c) => c.path === '/v1/operator/session');
    assert.equal(sessions.length, 1, 'the operator credential should be exchanged once');
  });
});

test('the credit tool states the balance and the unit', async () => {
  await withServer({ balanceMillicredits: 123_500 }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('get_credit_balance');
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /123\.5 compute credits remaining/);
    assert.match(result.content[0].text, /1 active standard-environment minute/);
  });
});

test('a refusal reaches the model as a result with its numbers, not as a transport error', async () => {
  await withServer({ entitlementFull: true }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('create_environment', { name: 'one-too-many' });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /at your plan limit/);
    assert.match(text, /max_workspaces=3/);
    assert.match(text, /live_workspaces=3/);
    assert.match(text, /archive an environment or upgrade the plan/);
    assert.match(text, /\[403 entitlement_limit\]/);
  });
});

/** The agent path: an API key, which mints its own capability server-side. */
const WITH_API_KEY = { env: { REACHPAD_API_KEY: 'rpak1.test.secret' } };

test('an API key runs a command without minting a workspace token (ADR-0059)', async () => {
  await withServer({ ...WITH_API_KEY }, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { environment: 'ws-42', argv: ['true'] });
    assert.equal(result.isError, false);
    assert.equal(
      stub.state.calls.filter((c) => c.path.endsWith('/token')).length,
      0,
      'a key-authorized exec must not ask for a Biscuit',
    );
    assert.equal(
      stub.state.calls.filter((c) => c.path === '/v1/operator/session').length,
      0,
      'a key-authorized exec must not need the operator credential either',
    );
  });
});

test('exec concurrency and capacity refusals carry their counts', async () => {
  await withServer({ execBehaviour: 'concurrency', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { environment: 'ws-9', argv: ['true'] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exec_max_concurrent=4 running=4/);
  });

  await withServer({ execBehaviour: 'no_capacity', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { environment: 'ws-9', argv: ['true'] });
    assert.match(result.content[0].text, /cause=all_full/);
  });
});

test('a resume is narrated, not hidden', async () => {
  await withServer({ execBehaviour: 'resuming', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { environment: 'ws-1', argv: ['true'] });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /paused and resumed/);
  });
});

test('a stream with no exec.end is a failure, never a zero exit (§5.2)', async () => {
  await withServer({ execBehaviour: 'truncated_stream', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { environment: 'ws-1', argv: ['true'] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /UNKNOWN/);
    assert.doesNotMatch(result.content[0].text, /exit 0/);
  });
});

test('create with a repo clones it, and a failed clone does not masquerade as success', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const ok = await client.call('create_environment', {
      name: 'app',
      repo: 'https://github.com/acme/app',
      ref: 'feature/foo',
    });
    assert.match(ok.content[0].text, /cloned https:\/\/github.com\/acme\/app at feature\/foo/);
    const exec = stub.state.calls.find((c) => c.path.endsWith('/exec'));
    assert.match(exec.body.argv[2], /git clone 'https:\/\/github.com\/acme\/app' \/work/);
    assert.match(exec.body.argv[2], /checkout 'feature\/foo'/);
    assert.match(exec.body.argv[2], /^set -e/);
  });

  await withServer({ cloneFails: true }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const failed = await client.call('create_environment', { name: 'app', repo: 'https://x/y' });
    assert.match(failed.content[0].text, /clone FAILED/);
    assert.match(failed.content[0].text, /repository not found/);
    // The environment still exists, and the text says so rather than implying
    // the whole call failed.
    assert.match(failed.content[0].text, /environment ws-1 created/);
  });
});

test('an unknown tool is a protocol error, not a tool result', async () => {
  await withServer({}, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const response = await client.send('tools/call', { name: 'expose_port', arguments: {} });
    assert.ok(response.error, 'a tool this server never advertised must not answer as a tool');
    assert.equal(response.error.code, -32602);
  });
});

test('malformed input does not kill the server', async () => {
  await withServer({}, async (client) => {
    client.child.stdin.write('this is not json\n');
    const init = await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'reachpad');
  });
});
