/**
 * A stub of controld's `/v1` surface, shaped from `docs/API.md` §5 and §7.
 *
 * It exists so the protocol tests exercise the REAL server process over the
 * REAL wire and only fake the far end. Its refusals carry the same remedy
 * fields the live routes carry, because rendering those is the thing under
 * test.
 */

import { createServer } from 'node:http';

export async function startStubControld(options = {}) {
  const state = {
    workspaces: new Map(),
    calls: [],
    nextId: 1,
    execBehaviour: options.execBehaviour ?? 'ok',
    ...options,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const body = await readJson(req);
    state.calls.push({ method: req.method, path: url.pathname, body });

    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // --- credentials -----------------------------------------------------
    // ADR-0062: the per-user credential. The ROW supplies user and principal;
    // no request field does, which is the whole property, so this stub takes
    // them from its own configuration rather than from the body.
    if (url.pathname === '/v1/identity/session' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${state.identityCredential ?? 'rpop1.ident.secret'}`) {
        return send(403, { error: 'bad_operator_token' });
      }
      return send(200, {
        user_id: state.identityUser ?? 'u-per-user',
        principal_id: 'p-per-user',
        identity_token: 'identity-token-per-user',
        expires_at_ms: Date.now() + 3_600_000,
      });
    }

    if (url.pathname === '/v1/operator/session' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${state.operatorToken ?? 'rpop1.test.secret'}`) {
        return send(401, { error: 'operator_token_unknown' });
      }
      return send(200, {
        user_id: 'u-test',
        principal_id: 'p-test',
        identity_token: 'identity-token-1',
        expires_at_ms: Date.now() + 3_600_000,
      });
    }

    // --- workspaces ------------------------------------------------------
    if (url.pathname === '/v1/workspaces' && req.method === 'POST') {
      if (state.entitlementFull) {
        return send(403, {
          error: 'entitlement_limit',
          max_workspaces: 3,
          live_workspaces: 3,
          remedy: 'archive an environment or upgrade the plan',
        });
      }
      const id = `ws-${state.nextId++}`;
      state.workspaces.set(id, { id, name: body.name, forks: [], archived: false });
      return send(201, { workspace: { id }, biscuit: `biscuit-${id}` });
    }

    if (url.pathname === '/v1/workspaces' && req.method === 'GET') {
      const rows = [...state.workspaces.values()].map((ws) => ({
        id: ws.id,
        name: ws.name,
        forks: ws.forks,
        ...(ws.archived ? { archived_at_ms: 1 } : {}),
      }));
      return send(200, { workspaces: rows });
    }

    const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/(\w+)$/);
    if (match) {
      const [, id, verb] = match;
      const ws = state.workspaces.get(id);

      if (verb === 'token') {
        if (!ws) return send(404, { error: 'workspace_not_found' });
        return send(200, { biscuit: `biscuit-${id}` });
      }
      if (verb === 'lineage') {
        if (!ws) return send(404, { error: 'workspace_not_found' });
        return send(200, {
          head: state.head ?? { kind: 'disk', log_seq: 42 },
          forks: ws.forks,
          ancestors: [],
        });
      }
      if (verb === 'fork') {
        if (!ws) return send(404, { error: 'workspace_not_found' });
        const forkId = `ws-${state.nextId++}`;
        state.workspaces.set(forkId, { id: forkId, name: body.name ?? 'fork', forks: [], archived: false });
        ws.forks.push({ id: forkId });
        return send(201, { workspace: { id: forkId } });
      }
      if (verb === 'archive') {
        if (!ws) return send(404, { error: 'workspace_not_found' });
        ws.archived = true;
        return send(200, { archived_at_ms: 1 });
      }
      if (verb === 'exec') {
        return handleExec(state, body, res, send);
      }
    }

    return send(404, { error: 'no_such_route' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function handleExec(state, body, res, send) {
  if (state.execBehaviour === 'concurrency') {
    return send(429, {
      error: 'exec_concurrency_exceeded',
      exec_max_concurrent: 4,
      running: 4,
      remedy: 'wait for a running command to finish',
    });
  }
  if (state.execBehaviour === 'no_capacity') {
    return send(503, { error: 'no_capacity', cause: 'all_full', nodes: 3 });
  }

  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const line = (value) => res.write(`${JSON.stringify(value)}\n`);

  if (state.execBehaviour === 'truncated_stream') {
    // The §5.2 failure that must never be read as success: output, then the
    // connection ends with no terminal event.
    line({ ev: 'exec.out', exec_id: 'e-1', fd: 1, seq: 0, data_b64: b64('partial') });
    return res.end();
  }

  if (state.execBehaviour === 'resuming') {
    line({ ev: 'exec.waiting', exec_id: 'e-1', reason: 'resuming' });
  }

  const argv = body.argv ?? [];
  const script = argv.join(' ');
  const failing = state.execBehaviour === 'nonzero' || /false|exit 1/.test(script);
  const cloneFails = state.cloneFails && /git clone/.test(script);

  if (cloneFails || failing) {
    line({ ev: 'exec.out', exec_id: 'e-1', fd: 2, seq: 0, data_b64: b64('fatal: repository not found\n') });
    line({ ev: 'exec.end', exec_id: 'e-1', exit_code: 128, signal: null, duration_ms: 12, truncated: false, timed_out: false });
    return res.end();
  }

  line({ ev: 'exec.out', exec_id: 'e-1', fd: 1, seq: 0, data_b64: b64(state.stdout ?? 'hello from the guest\n') });
  line({
    ev: 'exec.end',
    exec_id: 'e-1',
    exit_code: 0,
    signal: null,
    duration_ms: 11,
    truncated: Boolean(state.truncated),
    timed_out: false,
  });
  res.end();
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
