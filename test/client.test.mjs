import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient, _internal as clientInternal } from '../src/client.js';
import { createServer } from '../src/server.js';
import { _internal as toolInternal } from '../src/tools.js';

const {
  MAX_EXEC_EVENT_BYTES,
  MAX_EXEC_OUTPUT_BYTES,
  TailBuffer,
  ndjson,
} = clientInternal;
const { renderExec } = toolInternal;

function clientWith(fetch) {
  return new ControlClient({ endpoint: 'http://127.0.0.1:7401', fetch });
}

function authenticatedClient(fetch) {
  const client = clientWith(fetch);
  client.identity = {
    userId: 'u-test',
    principalId: 'p-test',
    token: 'identity-token',
    expiresAtMs: Date.now() + 3_600_000,
  };
  return client;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function streamingResponse(chunks, contentLength) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: contentLength === undefined ? {} : { 'content-length': contentLength },
    },
  );
}

function stalledFetch() {
  return (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

function byteStream(chunks, { close = true, onCancel } = {}) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
      if (close) controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

test('ordinary requests enforce a deadline while fetch is stalled', async () => {
  const client = clientWith(stalledFetch());
  await assert.rejects(
    () => client.request('POST', '/v1/workspaces', { body: {}, timeoutMs: 20 }),
    /timed out after 20 ms.*UNKNOWN.*do not retry/i,
  );
});

test('the ordinary request deadline also covers a stalled response body', async () => {
  const client = clientWith(async () =>
    new Response(
      new ReadableStream({
        start() {
          // Headers arrived, but the body never produces a byte or closes.
        },
      }),
      { status: 200 },
    ),
  );

  await assert.rejects(
    () => client.request('GET', '/v1/workspaces', { timeoutMs: 20 }),
    /timed out after 20 ms.*UNKNOWN/i,
  );
});

test('a caller abort is composed with, and distinguished from, the deadline', async () => {
  const client = clientWith(stalledFetch());
  const abort = new AbortController();
  const pending = client.request('POST', '/v1/workspaces', {
    body: {},
    signal: abort.signal,
    timeoutMs: 10_000,
  });
  abort.abort(new Error('caller stopped waiting'));

  await assert.rejects(pending, /cancelled by the caller.*UNKNOWN/i);
});

test('a response exactly at the byte limit is accepted', async () => {
  const limit = 64;
  const empty = JSON.stringify({ data: '' });
  const text = JSON.stringify({ data: 'x'.repeat(limit - Buffer.byteLength(empty)) });
  assert.equal(Buffer.byteLength(text), limit);

  const client = clientWith(async () => new Response(text, { status: 200 }));
  assert.deepEqual(
    await client.request('GET', '/exact', { maxResponseBytes: limit }),
    JSON.parse(text),
  );
});

test('streamed responses cannot evade the byte limit with false or absent Content-Length', async () => {
  for (const contentLength of [undefined, '1']) {
    const client = clientWith(async () =>
      streamingResponse(['x'.repeat(32), 'y'.repeat(33)], contentLength),
    );
    await assert.rejects(
      () => client.request('POST', '/oversized', { body: {}, maxResponseBytes: 64 }),
      /exceeded 64 bytes.*may have completed.*do not retry/i,
      `content-length ${contentLength ?? '(absent)'}`,
    );
  }
});

test('successful malformed bodies fail clearly instead of becoming success-shaped data', async () => {
  const nonJson = clientWith(async () => new Response('not json', { status: 200 }));
  await assert.rejects(
    () => nonJson.request('POST', '/create', { body: {} }),
    /HTTP 200 with a non-JSON body.*may have completed.*do not retry/i,
  );

  const array = clientWith(async () => jsonResponse([]));
  await assert.rejects(
    () => array.request('GET', '/list'),
    /expected a JSON object, got array/i,
  );
});

test('required identity, collection, and numeric fields reject unusable wire shapes', async () => {
  for (const expiresAtMs of ['', null]) {
    const client = new ControlClient({
      endpoint: 'http://127.0.0.1:7401',
      operatorToken: 'operator-token',
      fetch: async () =>
        jsonResponse({
          user_id: 'u-test',
          principal_id: 'p-test',
          identity_token: 'identity-token',
          expires_at_ms: expiresAtMs,
        }),
    });
    await assert.rejects(() => client.identityToken(), /expires_at_ms must be a finite number/i);
  }

  const expiring = new ControlClient({
    endpoint: 'http://127.0.0.1:7401',
    operatorToken: 'operator-token',
    fetch: async () =>
      jsonResponse({
        user_id: 'u-test',
        principal_id: 'p-test',
        identity_token: 'identity-token',
        expires_at_ms: Date.now() + 1_000,
      }),
  });
  await assert.rejects(() => expiring.identityToken(), /must remain valid for more than 60000 ms/i);

  const missingCollection = authenticatedClient(async () => jsonResponse({}));
  await assert.rejects(() => missingCollection.listWorkspaces(), /workspaces must be an array/i);

  for (const balance of ['', null]) {
    const invalidBalance = authenticatedClient(async () =>
      jsonResponse({ balance_millicredits: balance }),
    );
    await assert.rejects(
      () => invalidBalance.creditBalance(),
      /balance_millicredits must be a finite number/i,
    );
  }
});

test('provider errors cannot disclose a bearer credential through messages, causes, or MCP rendering', async () => {
  const secret = 'secret-biscuit-sentinel';
  const requests = [];
  const leakingFetch = async (url, init) => {
    requests.push({ url, authorization: init.headers.authorization });
    // Deliberately simulate a provider that reports both URL and headers. The
    // wrapped error/cause may retain the safe class and code, never this text.
    const error = new TypeError(
      `fetch failed for ${url} with ${init.headers.authorization}`,
    );
    error.code = 'UND_ERR_SOCKET';
    throw error;
  };
  const client = clientWith(leakingFetch);
  client.biscuits.set('ws-secret', {
    token: secret,
    expiresAtMs: Date.now() + 3_600_000,
  });

  let failure;
  try {
    await client.lineage('ws-secret');
    assert.fail('lineage should fail');
  } catch (error) {
    failure = error;
  }
  const thrown = `${failure.message}\n${failure.stack}\n${failure.cause?.message}\n${failure.cause?.stack}`;
  assert.doesNotMatch(thrown, new RegExp(secret));
  assert.match(failure.message, /TypeError, UND_ERR_SOCKET/);
  assert.equal(failure.cause?.message, 'TypeError (UND_ERR_SOCKET)');
  assert.equal(requests[0].url, 'http://127.0.0.1:7401/v1/workspaces/ws-secret/lineage');
  assert.equal(requests[0].authorization, `Bearer ${secret}`);
  assert.doesNotMatch(requests[0].url, new RegExp(secret));

  const server = createServer({
    env: { REACHPAD_ENDPOINT: 'http://127.0.0.1:7401' },
    fetchImpl: leakingFetch,
  });
  server.client.biscuits.set('ws-secret', {
    token: secret,
    expiresAtMs: Date.now() + 3_600_000,
  });
  const frame = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_workspace', arguments: { workspace: 'ws-secret' } },
  });
  assert.equal(frame.result.isError, true);
  assert.doesNotMatch(JSON.stringify(frame), new RegExp(secret));
  assert.match(frame.result.content[0].text, /TypeError, UND_ERR_SOCKET/);
});

test('exec rejects unsafe and out-of-cap timeouts before credentials or fetch', async () => {
  let fetches = 0;
  const client = new ControlClient({
    endpoint: 'http://127.0.0.1:7401',
    apiKey: 'api-key',
    fetch: async () => {
      fetches += 1;
      throw new Error('must not fetch');
    },
  });
  for (const timeoutMs of [0, 1.5, 600_001, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    await assert.rejects(
      () => client.exec('ws-1', { argv: ['true'], timeoutMs }),
      /safe integer between 1 and 600000 ms/,
    );
  }
  assert.equal(fetches, 0);
});

test('exec fetch and stream failures cannot disclose request secrets through MCP results', async () => {
  const secret = 'exec-secret-sentinel';
  const failures = [
    async (url, init) => {
      const error = new TypeError(`fetch ${url} with ${init.headers.authorization}`);
      error.code = 'UND_ERR_SOCKET';
      error.cause = new Error(`nested ${secret}`);
      throw error;
    },
    async (url, init) => {
      const stream = new ReadableStream({
        start(controller) {
          const error = new Error(
            `stream failed for ${url} with ${init.headers.authorization}`,
          );
          error.name = 'ExecSecretSentinelError';
          error.code = 'EXEC_SECRET_SENTINEL';
          error.cause = new Error(`nested ${secret}`);
          controller.error(error);
        },
      });
      return new Response(stream, { status: 200 });
    },
    async () => new Response(
      `${JSON.stringify({
        error: secret,
        detail: `Authorization: Bearer ${secret}`,
        cause: `https://user:${secret}@provider.invalid/exec`,
      })}\n`,
      { status: 403 },
    ),
  ];

  for (const fetchImpl of failures) {
    const server = createServer({
      env: {
        REACHPAD_ENDPOINT: 'http://127.0.0.1:7401',
        REACHPAD_API_KEY: secret,
      },
      fetchImpl,
    });
    const frame = await server.handle({
      jsonrpc: '2.0',
      id: 'exec-error',
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: { workspace: 'ws-secret', argv: ['possibly-ran'] },
      },
    });
    assert.equal(frame.result.isError, true);
    const rendered = JSON.stringify(frame);
    assert.doesNotMatch(rendered, new RegExp(secret));
    assert.doesNotMatch(rendered, /EXEC_SECRET_SENTINEL|ExecSecretSentinelError/);
    assert.doesNotMatch(rendered, /authorization|127\.0\.0\.1:7401/i);
    assert.match(
      frame.result.content[0].text,
      /exec failed before a complete result.*UNKNOWN|control plane refused this \(unknown\)/i,
    );
  }
});

test('exec output storage is bounded independently of server truncation', async () => {
  const stdout = `stdout-prefix-${'x'.repeat(MAX_EXEC_OUTPUT_BYTES)}`;
  const stderr = `stderr-prefix-${'y'.repeat(MAX_EXEC_OUTPUT_BYTES + 7)}`;
  const events = [
    { ev: 'exec.out', fd: 1, data_b64: Buffer.from(stdout).toString('base64') },
    { ev: 'exec.out', fd: 2, data_b64: Buffer.from(stderr).toString('base64') },
    {
      ev: 'exec.end',
      exit_code: 1,
      signal: null,
      duration_ms: 9,
      truncated: false,
      timed_out: false,
    },
  ];
  const client = new ControlClient({
    endpoint: 'http://127.0.0.1:7401',
    apiKey: 'api-key',
    fetch: async () => new Response(`${events.map(JSON.stringify).join('\n')}\n`, { status: 200 }),
  });

  const result = await client.exec('ws-1', { argv: ['large-output'] });
  assert.equal(Buffer.byteLength(result.stdout), MAX_EXEC_OUTPUT_BYTES);
  assert.equal(Buffer.byteLength(result.stderr), MAX_EXEC_OUTPUT_BYTES);
  assert.equal(result.stdout_dropped_bytes, Buffer.byteLength(stdout) - MAX_EXEC_OUTPUT_BYTES);
  assert.equal(result.stderr_dropped_bytes, Buffer.byteLength(stderr) - MAX_EXEC_OUTPUT_BYTES);
  assert.equal(result.stdout, stdout.slice(-MAX_EXEC_OUTPUT_BYTES));
  assert.equal(result.stderr, stderr.slice(-MAX_EXEC_OUTPUT_BYTES));
  assert.equal(result.truncated, false, 'truncated remains the server-provided entitlement signal');

  const rendered = renderExec(result);
  assert.match(rendered, /bytes dropped by the client memory limit/);
  assert.doesNotMatch(rendered, /truncated server-side/);
});

test('NDJSON accepts an exact-limit line and decodes a multibyte code point split across chunks', async () => {
  const limit = 64;
  const base = JSON.stringify({ snow: '雪', pad: '' });
  const line = JSON.stringify({
    snow: '雪',
    pad: 'x'.repeat(limit - Buffer.byteLength(base)),
  });
  const bytes = Buffer.from(line);
  assert.equal(bytes.length, limit);
  const snow = Buffer.from('雪');
  const split = bytes.indexOf(snow) + 1;
  assert.ok(split > 0, 'the test must split inside the three-byte code point');
  const stream = byteStream([
    bytes.subarray(0, split),
    bytes.subarray(split),
    Buffer.from('\n'),
  ]);

  const lines = [];
  for await (const value of ndjson(stream, { maxLineBytes: limit })) lines.push(value);
  assert.deepEqual(lines, [line]);
  assert.equal(stream.locked, false, 'a completed response releases its reader lock');
});

test('an oversized unterminated exec event is cancelled with an UNKNOWN outcome', async () => {
  let cancelled;
  const stream = byteStream([Buffer.alloc(MAX_EXEC_EVENT_BYTES + 1, 0x78)], {
    close: false,
    onCancel(reason) {
      cancelled = reason;
    },
  });
  const client = new ControlClient({
    endpoint: 'http://127.0.0.1:7401',
    apiKey: 'api-key',
    fetch: async () => new Response(stream, { status: 200 }),
  });

  await assert.rejects(
    () => client.exec('ws-1', { argv: ['possibly-ran'] }),
    /exec stream event exceeded 262144 bytes.*UNKNOWN.*cancelled/i,
  );
  assert.equal(cancelled?.name, 'NdjsonLineLimitError');
  assert.equal(stream.locked, false, 'overflow cancellation releases the response reader');
});

test('aborting an NDJSON read cancels and releases a stalled response stream', async () => {
  let cancelled;
  const stream = byteStream([], {
    close: false,
    onCancel(reason) {
      cancelled = reason;
    },
  });
  const abort = new AbortController();
  const iterator = ndjson(stream, { maxLineBytes: 64, signal: abort.signal });
  const pending = iterator.next();
  abort.abort();

  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(cancelled?.name, 'AbortError');
  assert.equal(stream.locked, false, 'abort cancellation releases the response reader');
});

test('exec output at the memory limit is retained without a false drop diagnostic', () => {
  const empty = new TailBuffer(4);
  for (let index = 0; index < 1_000; index += 1) empty.push(Buffer.alloc(0));
  assert.equal(empty.size, 0);
  assert.equal(empty.chunks.length, 0, 'empty events must not grow retained metadata');

  const buffer = new TailBuffer(4);
  buffer.push(Buffer.from('ab'));
  buffer.push(Buffer.from('cd'));
  assert.equal(buffer.toString(), 'abcd');
  assert.equal(buffer.dropped, 0);

  buffer.push(Buffer.from('e'));
  assert.equal(buffer.toString(), 'bcde');
  assert.equal(buffer.dropped, 1);
});
