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
      'checkpoint_workspace',
      'create_workspace',
      'delete_workspace',
      'expose_port',
      'get_credit_balance',
      'get_workspace',
      'list_ports',
      'list_workspaces',
      'pause_workspace',
      'revoke_port',
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
    assert.equal(byName.list_workspaces.annotations.readOnlyHint, true);
    assert.equal(byName.delete_workspace.annotations.destructiveHint, true);
    assert.ok(
      !byName.create_workspace.inputSchema.required?.includes('name'),
      'creating a workspace must not make the caller invent a name',
    );
  });
});

test('the pre-0.4.0 names still work, and are not advertised', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

    // Not in `tools/list`: nothing new should learn the old spelling.
    const listed = await client.send('tools/list');
    const names = listed.result.tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name.endsWith('_environment')).length, 0);

    // Still dispatched: a client holding a cached tool list, or an agent
    // quoting an older README, must not hit "unknown tool".
    const created = await client.call('create_environment', {});
    assert.equal(created.isError, false);
    assert.match(created.content[0].text, /workspace ws-1 created/);

    // The old ARGUMENT name too — renaming it is the same break as renaming
    // the tool, and it appears in every call an agent makes after the first.
    const ran = await client.call('run_command', { environment: 'ws-1', argv: ['true'] });
    assert.equal(ran.isError, false);
    assert.match(ran.content[0].text, /exit 0/);
    const exec = stub.state.calls.find((call) => call.path.includes('/exec'));
    assert.match(exec.path, /ws-1/, 'the legacy argument must reach the same workspace');

    // A caller that sends both means the current spelling. Preferring the
    // legacy key would run the command in a workspace it did not name.
    await client.call('list_ports', { workspace: 'ws-1', environment: 'ws-2' });
    const ports = stub.state.calls.filter((call) => call.path.includes('port-shares')).pop();
    assert.match(ports.path, /ws-1/);
  });
});

test('the whole arc: create, run, checkpoint, list, delete', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

    const created = await client.call('create_workspace', {});
    assert.match(
      created.content[0].text,
      /workspace ws-1 created \(name: workspace-000000000001\)/,
    );
    assert.equal(created.isError, false);
    const createCall = stub.state.calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/workspaces',
    );
    assert.equal(createCall.body.name, undefined, 'MCP must let the server generate the name');

    const ran = await client.call('run_command', {
      workspace: 'ws-1',
      argv: ['/bin/sh', '-lc', 'echo hi'],
    });
    assert.match(ran.content[0].text, /exit 0 after 11 ms/);
    assert.match(ran.content[0].text, /hello from the guest/);

    const forked = await client.call('checkpoint_workspace', { workspace: 'ws-1', name: 'try-b' });
    assert.match(forked.content[0].text, /forked ws-1 → ws-2 \(try-b\)/);

    const listed = await client.call('list_workspaces');
    assert.match(listed.content[0].text, /ws-1\s+workspace-000000000001\s+1 fork/);

    const deleted = await client.call('delete_workspace', { workspace: 'ws-1' });
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
    assert.match(result.content[0].text, /1 active standard-workspace minute/);
  });
});

test('a refusal reaches the model as a result with its numbers, not as a transport error', async () => {
  await withServer({ entitlementFull: true }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('create_workspace', { name: 'one-too-many' });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /at your plan limit/);
    assert.match(text, /max_workspaces=3/);
    assert.match(text, /live_workspaces=3/);
    assert.match(text, /archive a workspace or upgrade the plan/);
    assert.match(text, /\[403 entitlement_limit\]/);
  });
});

/** The agent path: an API key, which mints its own capability server-side. */
const WITH_API_KEY = { env: { REACHPAD_API_KEY: 'rpak1.test.secret' } };

test('an API key runs a command without minting a workspace token (ADR-0059)', async () => {
  await withServer({ ...WITH_API_KEY }, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { workspace: 'ws-42', argv: ['true'] });
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
    const result = await client.call('run_command', { workspace: 'ws-9', argv: ['true'] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exec_max_concurrent=4 running=4/);
  });

  await withServer({ execBehaviour: 'no_capacity', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { workspace: 'ws-9', argv: ['true'] });
    assert.match(result.content[0].text, /cause=all_full/);
  });
});

test('a resume is narrated, not hidden', async () => {
  await withServer({ execBehaviour: 'resuming', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { workspace: 'ws-1', argv: ['true'] });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /paused and resumed/);
  });
});

test('a stream with no exec.end is a failure, never a zero exit (§5.2)', async () => {
  await withServer({ execBehaviour: 'truncated_stream', ...WITH_API_KEY }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const result = await client.call('run_command', { workspace: 'ws-1', argv: ['true'] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /UNKNOWN/);
    assert.doesNotMatch(result.content[0].text, /exit 0/);
  });
});

test('create with a repo clones it, and a failed clone does not masquerade as success', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const ok = await client.call('create_workspace', {
      name: 'app',
      repo: 'https://github.com/acme/app',
      ref: 'feature/foo',
    });
    assert.match(ok.content[0].text, /cloned https:\/\/github.com\/acme\/app at feature\/foo/);
    const exec = stub.state.calls.find((c) => c.path.endsWith('/exec'));
    // `$HOME/work`, never `/work`: the guest rootfs is read-only, so the
    // literal path this used to assert failed on every real workspace.
    assert.match(exec.body.argv[2], /git clone 'https:\/\/github.com\/acme\/app' "\$HOME\/work"/);
    assert.doesNotMatch(exec.body.argv[2], /mkdir -p \/work/);
    assert.match(exec.body.argv[2], /checkout 'feature\/foo'/);
    assert.match(exec.body.argv[2], /^set -e/);
  });

  await withServer({ cloneFails: true }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const failed = await client.call('create_workspace', { name: 'app', repo: 'https://x/y' });
    assert.match(failed.content[0].text, /clone FAILED/);
    assert.match(failed.content[0].text, /repository not found/);
    // The workspace still exists, and the text says so rather than implying
    // the whole call failed.
    assert.match(failed.content[0].text, /workspace ws-1 created/);
  });
});

test('expose_port opens a port, is idempotent, and says what it does not guarantee', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });

    const first = await client.call('expose_port', { workspace: 'ws-1', port: 3000, check: false });
    assert.match(first.content[0].text, /port 3000 in ws-1 is open at https:\/\/app\.example\.test\/token-/);
    // The two facts a caller acts on, and neither is discoverable from a URL.
    assert.match(first.content[0].text, /signed in to Reachpad/);
    assert.match(first.content[0].text, /does NOT survive a pause/i);

    // Idempotent per live (workspace, port): the SAME link, not a second one.
    const again = await client.call('expose_port', { workspace: 'ws-1', port: 3000, check: false });
    assert.equal(first.content[0].text.split('\n')[0], again.content[0].text.split('\n')[0]);

    const listed = await client.call('list_ports', { workspace: 'ws-1' });
    assert.equal(listed.content[0].text.trim().split('\n').length, 1);
    assert.match(listed.content[0].text, /^3000\s+https:/);
  });
});

test('expose_port reports a port nothing is listening on', async () => {
  // Exit 1 is the probe's "connected to nothing", and the reason the stub
  // grew an exact exit code: a blanket non-zero cannot tell that apart from
  // a probe that could not run at all.
  await withServer({ execExitCode: 1 }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });
    const result = await client.call('expose_port', { workspace: 'ws-1', port: 8080 });
    assert.match(result.content[0].text, /NOTHING IS LISTENING on 8080/);
    // Still a success: the share exists, and the caller is told what to do.
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /is open at/);
  });
});

test('a probe that cannot run says so, and never calls the port dead', async () => {
  // 127 is `command not found` — the probe did not run, which is NOT evidence
  // that nothing is listening. Reporting it as dead would send an agent to
  // restart a server that was serving perfectly well.
  await withServer({ execExitCode: 127 }, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });
    const result = await client.call('expose_port', { workspace: 'ws-1', port: 8080 });
    assert.match(result.content[0].text, /could not check whether anything is listening/);
    assert.doesNotMatch(result.content[0].text, /NOTHING IS LISTENING/);
  });
});

test('revoke_port closes it, and the closed one stops being listed', async () => {
  await withServer({}, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });
    await client.call('expose_port', { workspace: 'ws-1', port: 3000, check: false });

    const revoked = await client.call('revoke_port', { workspace: 'ws-1', port: 3000 });
    assert.match(revoked.content[0].text, /port 3000 is closed in ws-1/);
    assert.match(revoked.content[0].text, /mints a new one/);

    const listed = await client.call('list_ports', { workspace: 'ws-1' });
    assert.match(listed.content[0].text, /no ports are open in ws-1/);

    // A second revoke is a refusal the model can read, not a crash.
    const twice = await client.call('revoke_port', { workspace: 'ws-1', port: 3000 });
    assert.equal(twice.isError, true);
  });
});

test('pause_workspace seals a running workspace, and is honest when there is nothing to seal', async () => {
  await withServer({}, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });

    const paused = await client.call('pause_workspace', { workspace: 'ws-1' });
    assert.match(paused.content[0].text, /is saving its disk and stopping/);
    // The sentence an agent has to act on: its server is gone.
    assert.match(paused.content[0].text, /with nothing running inside it/);
    const release = stub.state.calls.find((c) => c.path.endsWith('/release'));
    assert.equal(release.body.fencing_token, 7);
    // Never a discard: this surface has no verb meaning "throw the work away".
    assert.equal(release.body.discard, false);
  });

  // Already paused is not an error, and must not send a release at all.
  await withServer({ wsState: 'paused' }, async (client, stub) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });
    const again = await client.call('pause_workspace', { workspace: 'ws-1' });
    assert.match(again.content[0].text, /already paused/);
    assert.equal(stub.state.calls.some((c) => c.path.endsWith('/release')), false);
  });
});

test('get_workspace reports whether it is running', async () => {
  await withServer({}, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    await client.call('create_workspace', { name: 'app' });
    const info = await client.call('get_workspace', { workspace: 'ws-1' });
    assert.match(info.content[0].text, /state: running/);
    assert.match(info.content[0].text, /spends a credit a minute/);
  });
});

test('an unknown tool is a protocol error, not a tool result', async () => {
  await withServer({}, async (client) => {
    await client.send('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    // `start_agent`, not `expose_port`: the latter is a real tool now, and a
    // negative test naming a shipped tool passes for the wrong reason.
    const response = await client.send('tools/call', { name: 'start_agent', arguments: {} });
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
