/**
 * Which account a connection acts as, said out loud.
 *
 * The failure this prevents is not an error — it is silence. Authorize with a
 * different email than the one your reachpad account uses and everything
 * works: you get a valid token, a real account, and an empty workspace list.
 * That reads as "my work is gone" rather than "wrong login", and nothing
 * anywhere contradicts it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { startStubControld } from './lib/stub-controld.mjs';

async function withServer(env, body) {
  const stub = await startStubControld({});
  const server = createServer({
    env: {
      REACHPAD_ENDPOINT: stub.endpoint,
      REACHPAD_OPERATOR_TOKEN: 'rpop1.test.secret',
      ...env,
    },
  });
  const call = async (name, args = {}) => {
    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return res.result.content[0].text;
  };
  try {
    await body({ server, call, stub });
  } finally {
    await stub.close();
  }
}

test('the handshake names the account, and says what a mismatch looks like', async () => {
  await withServer({ REACHPAD_ACCOUNT_LABEL: 'seiji@example.com' }, async ({ server }) => {
    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    assert.match(res.result.instructions, /acts as seiji@example\.com/);
    // The instruction has to tell a model what to DO with it, or it is a fact
    // nobody surfaces at the moment it matters.
    assert.match(res.result.instructions, /different email/);
  });
});

test('an empty list says WHOSE list is empty', async () => {
  await withServer({ REACHPAD_ACCOUNT_LABEL: 'seiji@example.com' }, async ({ call }) => {
    const text = await call('list_workspaces');
    assert.match(text, /account: seiji@example\.com/);
    assert.match(text, /No workspaces yet/);
  });
});

test('a populated list carries it too', async () => {
  await withServer({ REACHPAD_ACCOUNT_LABEL: 'seiji@example.com' }, async ({ call }) => {
    await call('create_workspace', { name: 'demo' });
    const text = await call('list_workspaces');
    assert.match(text, /^account: seiji@example\.com/);
    assert.match(text, /ws-1\s+demo/);
  });
});

test('without a label nothing is invented', async () => {
  await withServer({}, async ({ server, call }) => {
    const res = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    // A host that does not know the account must not get a sentence claiming
    // one — the stdio path has no idea who the person is.
    assert.equal(res.result.instructions, undefined);
    assert.doesNotMatch(await call('list_workspaces'), /account:/);
  });
});
