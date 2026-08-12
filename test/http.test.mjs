/**
 * The remote wire, over a real socket: the same tools a connector would call,
 * plus the refusals that keep an HTTP endpoint from being the weakest thing in
 * the chain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createMcpServer } from '../src/server.js';
import { listen } from '../src/http.js';
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
    assert.equal(listed.result.tools.length, 7);

    const called = await (
      await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'create_environment', arguments: { name: 'over-http' } },
      })
    ).json();
    assert.match(called.result.content[0].text, /environment ws-1 created/);
  });
});

test('a notification is accepted with nothing to say', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc }) => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), '');
  });
});

test('a batch answers each message that has an id', async () => {
  await withHttp({ token: TOKEN }, async ({ rpc }) => {
    const res = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const body = await res.json();
    assert.equal(body.length, 2, 'the notification contributes no response');
    assert.deepEqual(
      body.map((one) => one.id),
      [1, 2],
    );
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
