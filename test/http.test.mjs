/**
 * The remote wire, over a real socket: the same tools a connector would call,
 * plus the refusals that keep an HTTP endpoint from being the weakest thing in
 * the chain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createMcpServer } from '../src/server.js';
import { createHttpHandler, listen } from '../src/http.js';
import { startStubControld } from './lib/stub-controld.mjs';

const TOKEN = 'test-bearer-token';

async function withHttp(options, body) {
  const stub = await startStubControld(options.stub ?? {});
  const mcp = createMcpServer({
    env: {
      REACHPAD_ENDPOINT: stub.endpoint,
      REACHPAD_OPERATOR_TOKEN: 'rpop1.test.secret',
      ...(options.env ?? {}),
    },
    fetchImpl: options.fetchImpl,
  });
  const http = await listen(mcp, { token: options.token, allowedOrigins: options.allowedOrigins });
  const { port } = http.address();
  const url = `http://127.0.0.1:${port}/mcp`;
  const rpc = async (message, init = {}) => {
    const { headers: extra, ...rest } = init;
    return fetch(url, {
      method: 'POST',
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(extra ?? {}),
      },
      body: JSON.stringify(message),
    });
  };
  try {
    await body({ url, rpc, stub });
  } finally {
    await new Promise((resolve) => http.close(resolve));
    await stub.close();
  }
}

test('a connector can handshake and call a tool over HTTP', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc }) => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('cache-control'), 'no-store');
    const body = await init.json();
    assert.equal(body.result.serverInfo.name, 'reachpad');

    const listed = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    // The COUNT only, deliberately: this test is about the HTTP transport
    // carrying the same surface stdio does, and `protocol.test.mjs` is where
    // the names are pinned. Update both when a tool is added.
    assert.equal(listed.result.tools.length, 11);

    const called = await (
      await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'create_workspace', arguments: { name: 'over-http' } },
      })
    ).json();
    assert.match(called.result.content[0].text, /workspace ws-1 created/);
  });
});

test('a notification is accepted with nothing to say', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc }) => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');

    const unknown = await rpc({ jsonrpc: '2.0', method: 'untrusted-secret-method' });
    assert.equal(unknown.status, 202, 'even an unknown valid notification gets no response');
    assert.equal(await unknown.text(), '');
  });
});

test('every HTTP JSON-RPC batch is refused before dispatch', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc, stub }) => {
    const before = stub.state.calls.length;
    for (const messages of [
      [],
      [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_workspace', arguments: { name: 'must-not-exist' } },
        },
        { jsonrpc: '2.0', method: 'ping' },
      ],
    ]) {
      const response = await rpc(messages);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, -32600);
      assert.match(body.error.message, /batches are not supported/);
    }
    assert.equal(stub.state.calls.length, before, 'no unsupported-batch member is dispatched');
  });
});

test('HTTP rejects malformed envelopes with -32600 and never reflects their values', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc, stub }) => {
    const secret = 'http-rpc-secret-sentinel';
    const malformed = [
      null,
      secret,
      {},
      {
        jsonrpc: '1.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_workspace', arguments: { name: secret } },
      },
      { jsonrpc: '2.0', id: true, method: 'ping' },
      { jsonrpc: '2.0', id: null, method: 'ping' },
      { jsonrpc: '2.0', id: 1, method: 4 },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: null },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: [] },
      { jsonrpc: '2.0', id: 1, method: 'ping', params: secret },
    ];
    const before = stub.state.calls.length;
    for (const message of malformed) {
      const response = await rpc(message);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, null);
      assert.equal(body.error.code, -32600);
      assert.match(body.error.message, /^invalid request:/);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
    }
    assert.equal(stub.state.calls.length, before, 'malformed envelopes never reach controld');
  });
});

test('HTTP enforces an explicitly supplied MCP protocol revision', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc }) => {
    const supported = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { headers: { 'mcp-protocol-version': '2025-06-18' } },
    );
    assert.equal(supported.status, 200);

    const unsupported = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { headers: { 'mcp-protocol-version': '2025-03-26' } },
    );
    assert.equal(unsupported.status, 400);
    const body = await unsupported.json();
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /unsupported MCP protocol version/);
  });
});

test('no token, no service — and the refusal says what to present', async () => {
  await withHttp({ token: TOKEN }, async ({ url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  });

  await withHttp({ token: TOKEN }, async ({ url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
  });
});

test('a browser Origin is refused unless it was named (DNS rebinding)', async () => {
  await withHttp({ token: TOKEN, allowedOrigins: ['https://claude.ai'] }, async ({ rpc }) => {
    const refused = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(refused.status, 403);

    const allowed = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {
      headers: { origin: 'https://claude.ai' },
    });
    assert.equal(allowed.status, 200);

    // No Origin at all is a non-browser client, which is the normal case.
    const plain = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(plain.status, 200);
  });
});

test('GET is refused: this server opens no stream of its own', async () => {
  await withHttp({ token: TOKEN }, async ({ url }) => {
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

test('malformed JSON is a parse error, not a crash', async () => {
  await withHttp({ token: TOKEN }, async ({ url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32700);
  });
});

test('an oversized body is refused before it is parsed', async () => {
  await withHttp({ token: TOKEN }, async ({ url }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2_000_000) } }),
    });
    assert.equal(res.status, 413);
  });
});

test('no token is a refusal to start, not a decision to let everyone in', async () => {
  // The bug this pins: `if (token && !presentsToken(...))` — an unset token
  // short-circuited the guard, so every caller that could reach the port was
  // authorized on a process holding the user's reachpad credentials.
  const stub = await startStubControld({});
  const mcp = createMcpServer({
    env: { REACHPAD_ENDPOINT: stub.endpoint, REACHPAD_OPERATOR_TOKEN: 'rpop1.test.secret' },
  });
  try {
    assert.throws(() => createHttpHandler(mcp, {}), /refusing to serve an unauthenticated/);
    await assert.rejects(listen(mcp, {}), /refusing to serve an unauthenticated/);
  } finally {
    await stub.close();
  }
});

test('serving open is available, and has to be asked for by name', async () => {
  const stub = await startStubControld({});
  const mcp = createMcpServer({
    env: { REACHPAD_ENDPOINT: stub.endpoint, REACHPAD_OPERATOR_TOKEN: 'rpop1.test.secret' },
  });
  const http = await listen(mcp, { allowAnonymous: true });
  try {
    const { port } = http.address();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(res.status, 200);
  } finally {
    await new Promise((resolve) => http.close(resolve));
    await stub.close();
  }
});
