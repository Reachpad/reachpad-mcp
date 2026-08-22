/**
 * The same arc against a REAL controld — the fleet, or a dev-mode controld on
 * loopback. It SKIPS (never fails) when no endpoint is configured, exactly as
 * the live-Postgres suites do: the default suite must need zero real
 * dependencies.
 *
 *   REACHPAD_ENDPOINT=m1.reachpad.dev \
 *   REACHPAD_OPERATOR_TOKEN=rpop1.… \
 *   node --test test/live.test.mjs
 *
 * What it proves that the stub cannot: that the shapes this server reads out
 * of controld's answers are the shapes controld actually sends.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const endpoint = process.env.REACHPAD_ENDPOINT;
const credentialled = Boolean(
  process.env.REACHPAD_OPERATOR_TOKEN ||
    (process.env.REACHPAD_IDP_ASSERTION && process.env.REACHPAD_USER_ID),
);
const configured = Boolean(endpoint && credentialled);

test('live: the control plane answers the shapes this server reads', { skip: !configured }, async () => {
  const server = createServer({ env: process.env });

  const call = async (name, args = {}) => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return response.result;
  };

  const identity = await server.client.identityToken();
  assert.ok(identity.userId, 'the operator session must name a user');
  assert.ok(identity.token, 'the operator session must return an identity token');

  const stamp = `mcp-live-${Date.now()}`;
  const created = await call('create_environment', { name: stamp });
  assert.equal(created.isError, false, created.content[0].text);
  const id = created.content[0].text.match(/environment (\S+) created/)?.[1];
  assert.ok(id, `could not read the environment id out of: ${created.content[0].text}`);

  try {
    const listed = await call('list_environments');
    assert.match(listed.content[0].text, new RegExp(id));

    // Exec has exactly three legitimate outcomes against a real fleet, and the
    // property under test is that the third is never dressed up as the first:
    //
    //   1. it ran            — an exit code came back
    //   2. it was refused    — a status and a code came back
    //   3. no terminal event — UNKNOWN, and NOT a zero exit
    //
    // Three is what a dev controld produces: the dev fixture's node is a row,
    // not a running noded, so the exec is queued and never claimed. It is also
    // what a wedged node produces in production, which is why it is asserted
    // here rather than treated as a broken test environment.
    const ran = await call('run_command', {
      environment: id,
      argv: ['/bin/sh', '-lc', 'echo mcp-live-ok && id -u'],
      // Sixty seconds, not five. This environment has never run, so this
      // command pays for a COLD BOOT before the shell starts — measured at
      // ~4.7 s unloaded, and this box is simultaneously the only fleet node.
      // At five it was the timeout under test rather than the exec.
      timeout_ms: 60_000,
    });
    const text = ran.content[0].text;
    if (!ran.isError) {
      assert.match(text, /exit 0/, text);
      assert.match(text, /mcp-live-ok/, text);
      console.log('live: the command ran in a guest');
    } else if (/\[\d{3} \w+\]/.test(text)) {
      console.log(`live: exec refused, legibly — ${text.split('\n')[0]}`);
    } else {
      assert.match(text, /UNKNOWN/, `an unterminated stream must say so: ${text}`);
      assert.doesNotMatch(text, /exit 0/, 'a missing terminal event must never read as success');
      console.log(`live: no terminal event, reported as unknown — ${text.split('\n')[0]}`);
    }

    // --- the hosting arc, against the real preview plane -----------------
    //
    // The whole point of the port tools: something built in here becomes
    // something a person can open. Every assertion below is about a SHAPE
    // controld actually sends, which is the one thing the stub cannot prove.
    const exposed = await call('expose_port', { environment: id, port: 8080, check: false });
    if (!exposed.isError) {
      assert.match(exposed.content[0].text, /port 8080 in \S+ is open/, exposed.content[0].text);
      // Idempotent per live (workspace, port), server-side. Two calls, one link.
      const again = await call('expose_port', { environment: id, port: 8080, check: false });
      assert.equal(
        exposed.content[0].text.split('\n')[0],
        again.content[0].text.split('\n')[0],
        're-exposing an open port must return the SAME link, not a second one',
      );

      const ports = await call('list_ports', { environment: id });
      assert.match(ports.content[0].text, /^8080\s/m, ports.content[0].text);

      const revoked = await call('revoke_port', { environment: id, port: 8080 });
      assert.equal(revoked.isError, false, revoked.content[0].text);
      const empty = await call('list_ports', { environment: id });
      assert.match(empty.content[0].text, /no ports are open/, empty.content[0].text);
      console.log('live: expose → list → revoke, against the real preview plane');
    } else {
      // A fleet with no preview origin configured refuses legibly; that is a
      // deployment fact, not a broken tool, and it must not read as success.
      assert.match(exposed.content[0].text, /\[\d{3} \w+\]/, exposed.content[0].text);
      console.log(`live: port shares refused, legibly — ${exposed.content[0].text.split('\n')[0]}`);
    }
  } finally {
    // Pause BEFORE archive, and this ordering is the test's own history: a
    // running workspace holds a lease, and `archive` answers `409 lease_held`
    // — "release or pause the workspace before archiving it". This suite used
    // to end on that refusal every time it got as far as running a command,
    // because the surface had no verb that could clear it. `pause_environment`
    // is that verb, and this is the arc that could not complete without it.
    const paused = await call('pause_environment', { environment: id });
    assert.equal(paused.isError, false, paused.content[0].text);
    console.log(`live: ${paused.content[0].text.split(';')[0]}`);

    // Sealing is not instant, and archive refuses until the lease is gone.
    let deleted;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      deleted = await call('delete_environment', { environment: id });
      if (!deleted.isError) break;
      if (!/lease_held/.test(deleted.content[0].text)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    assert.equal(deleted.isError, false, deleted.content[0].text);
  }
});
