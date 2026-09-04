import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, serveStdio } from '../src/server.js';
import { MAX_MESSAGE_BYTES } from '../src/jsonrpc.js';

function stdioHarness(server) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  const waiters = [];
  let buffered = '';

  output.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else lines.push(value);
    }
  });

  const reader = serveStdio(server, input, output);
  return {
    write(value) {
      input.write(`${JSON.stringify(value)}\n`);
    },
    writeRaw(value) {
      input.write(`${value}\n`);
    },
    writeChunk(value) {
      input.write(value);
    },
    next() {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a stdio response')),
          2_000,
        );
        waiters.push({
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
        });
      });
    },
    close() {
      reader.close();
      input.destroy();
      output.destroy();
    },
  };
}

function localServer(fetchImpl = async () => {
  throw new Error('unexpected control-plane dispatch');
}) {
  return createServer({
    env: { REACHPAD_ENDPOINT: 'http://127.0.0.1:7401' },
    fetchImpl,
  });
}

test('stdio accepts MCP request ids and treats only an absent id as a notification', async () => {
  const wire = stdioHarness(localServer());
  try {
    for (const id of ['string-id', 1.5]) {
      wire.write({ jsonrpc: '2.0', id, method: 'ping' });
      const response = await wire.next();
      assert.equal(response.id, id);
      assert.deepEqual(response.result, {});
    }

    // Neither a known nor unknown valid notification may emit a response.
    wire.write({ jsonrpc: '2.0', method: 'ping' });
    wire.write({ jsonrpc: '2.0', method: 'private-secret-method' });
    wire.write({ jsonrpc: '2.0', id: 'after-notifications', method: 'ping' });
    const response = await wire.next();
    assert.equal(response.id, 'after-notifications');
  } finally {
    wire.close();
  }
});

test('stdio rejects malformed envelopes before dispatch without echoing their values', async () => {
  let dispatches = 0;
  const wire = stdioHarness(
    localServer(async () => {
      dispatches += 1;
      throw new Error('must not run');
    }),
  );
  const secret = 'rpc-secret-sentinel';
  const malformed = [
    [null, /expected a JSON object/],
    [secret, /expected a JSON object/],
    [{}, /jsonrpc must be exactly/],
    [
      {
        jsonrpc: '1.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_workspace', arguments: { name: secret } },
      },
      /jsonrpc must be exactly/,
    ],
    [{ jsonrpc: '2.0', id: 1, method: 7 }, /method must be a string/],
    [{ jsonrpc: '2.0', id: false, method: 'ping' }, /id must be a string/],
    [{ jsonrpc: '2.0', id: null, method: 'ping' }, /id must be a string/],
    [{ jsonrpc: '2.0', id: 1, method: 'ping', params: null }, /params must be an object/],
    [{ jsonrpc: '2.0', id: 1, method: 'ping', params: [] }, /params must be an object/],
    [{ jsonrpc: '2.0', id: 1, method: 'ping', params: secret }, /params must be an object/],
  ];

  try {
    for (const [message, diagnostic] of malformed) {
      wire.write(message);
      const response = await wire.next();
      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.id, null);
      assert.equal(response.error.code, -32600);
      assert.match(response.error.message, diagnostic);
      assert.doesNotMatch(JSON.stringify(response), new RegExp(secret));
    }

    wire.writeRaw(`{"jsonrpc":"2.0","method":"${secret}"`);
    const parseError = await wire.next();
    assert.equal(parseError.error.code, -32700);
    assert.doesNotMatch(JSON.stringify(parseError), new RegExp(secret));
    assert.equal(dispatches, 0);
  } finally {
    wire.close();
  }
});

test('stdio rejects every JSON-RPC array as one unsupported batch', async () => {
  let dispatches = 0;
  const wire = stdioHarness(
    localServer(async () => {
      dispatches += 1;
      throw new Error('must not run');
    }),
  );
  try {
    for (const batch of [
      [],
      [{ jsonrpc: '2.0', id: 'valid-looking', method: 'ping' }],
      [
        { jsonrpc: '2.0', method: 'ping' },
        { jsonrpc: '2.0', id: 'also-valid-looking', method: 'ping' },
      ],
    ]) {
      wire.write(batch);
      const response = await wire.next();
      assert.equal(response.id, null);
      assert.equal(response.error.code, -32600);
      assert.match(response.error.message, /batches are not supported/);
    }
    assert.equal(dispatches, 0, 'no member of an unsupported batch is dispatched');

    wire.write({ jsonrpc: '2.0', id: 'after-batch', method: 'ping' });
    assert.equal((await wire.next()).id, 'after-batch');
  } finally {
    wire.close();
  }
});

test('method and tool errors are diagnostic without reflecting untrusted names', async () => {
  const server = localServer();
  const secret = 'method-secret-sentinel';
  const method = await server.handle({ jsonrpc: '2.0', id: 1, method: secret });
  assert.equal(method.error.code, -32601);
  assert.equal(method.error.message, 'method not found');
  assert.doesNotMatch(JSON.stringify(method), new RegExp(secret));

  const tool = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: secret, arguments: {} },
  });
  assert.equal(tool.error.code, -32602);
  assert.equal(tool.error.message, 'unknown tool');
  assert.doesNotMatch(JSON.stringify(tool), new RegExp(secret));

  const argument = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'create_workspace', arguments: { [secret]: 'value' } },
  });
  assert.equal(argument.error.code, -32602);
  assert.match(argument.error.message, /property not declared by the schema/);
  assert.doesNotMatch(JSON.stringify(argument), new RegExp(secret));
});

test('stdio bounds an unterminated input line by bytes and accepts the exact limit', async () => {
  const wire = stdioHarness(localServer());
  try {
    const base = JSON.stringify({
      jsonrpc: '2.0',
      id: 'exact',
      method: 'ping',
      params: { pad: '' },
    });
    const exact = JSON.stringify({
      jsonrpc: '2.0',
      id: 'exact',
      method: 'ping',
      params: { pad: 'x'.repeat(MAX_MESSAGE_BYTES - Buffer.byteLength(base)) },
    });
    assert.equal(Buffer.byteLength(exact), MAX_MESSAGE_BYTES);
    wire.writeRaw(exact);
    const accepted = await wire.next();
    assert.equal(accepted.id, 'exact');
    assert.deepEqual(accepted.result, {});

    // No newline: the diagnostic must arrive as soon as the cap is crossed,
    // and the parser must discard through the next delimiter before resuming.
    wire.writeChunk(Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x78));
    const oversized = await wire.next();
    assert.equal(oversized.id, null);
    assert.equal(oversized.error.code, -32700);
    assert.match(oversized.error.message, /stdio message exceeds 1048576 bytes/);

    wire.writeChunk('\n');
    wire.write({ jsonrpc: '2.0', id: 'after-oversized', method: 'ping' });
    const recovered = await wire.next();
    assert.equal(recovered.id, 'after-oversized');
  } finally {
    wire.close();
  }
});
