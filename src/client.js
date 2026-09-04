/**
 * Thin client of controld's public `/v1` surface — the same routes `reach`
 * and the cockpit use. There is no privileged interface (I6), and this file
 * must never become one.
 *
 * Endpoint resolution follows ADR-0040: one host, one port. `m1.reachpad.dev`
 * means `https://m1.reachpad.dev`, and plaintext to anything that is not
 * loopback is refused before a socket opens.
 */

import { ApiError } from './errors.js';

const IDENTITY_SKEW_MS = 60_000;
const BISCUIT_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
// Tools render only the final 4,000 characters. Retaining 64 KiB per file
// descriptor leaves room for multibyte text while putting a hard ceiling on
// what an adversarial command can keep resident in this process.
const MAX_EXEC_OUTPUT_BYTES = 64 * 1024;
// One event can carry base64 output, so this is deliberately larger than the
// retained decoded tail. It still prevents a peer from holding megabytes of
// an unterminated JSON line before TailBuffer ever sees an exec.out event.
const MAX_EXEC_EVENT_BYTES = 256 * 1024;

/**
 * How long past an exec's own timeout the reachpad control plane holds a
 * caller's stream open before terminating it itself.
 *
 * This is a SERVER constant mirrored into a client, which is a thing that
 * silently rots. It does not rot here: the server's own CI fetches this
 * published package and fails if the two disagree, so the check lives where
 * the number would change rather than where it is copied. The dependency
 * points that way on purpose — the private repository reads this public
 * package, never the reverse.
 */
const EXEC_GRACE_MS = 150_000;

/**
 * What the server allows an exec that names no `timeout_ms` of its own. This
 * fallback MUST match it and not be a friendlier number — a client assuming
 * two minutes would abandon a ten-minute build the server was perfectly
 * willing to finish, which is the same defect as a deadline tighter than the
 * grace, one layer up. Both were real bugs here, found by running it.
 *
 * Both are entitlement fallbacks server-side, so a plan can move them. That is
 * a reason to pass `timeout_ms` explicitly, not a reason to guess lower.
 */
export const MAX_EXEC_TIMEOUT_MS = 600_000;

/** @param {string} raw */
export function resolveEndpoint(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('no endpoint: set REACHPAD_ENDPOINT');
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const url = hasScheme ? trimmed : `https://${trimmed}`;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported endpoint protocol ${parsed.protocol}; use https://`);
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new Error(
      `refusing plaintext http:// to ${parsed.hostname} — every control call carries a credential (ADR-0040)`,
    );
  }
  return parsed.origin;
}

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export class ControlClient {
  /**
   * @param {{endpoint: string, operatorToken?: string, apiKey?: string,
   *          idpAssertion?: string, userId?: string, principalId?: string,
   *          fetch?: typeof globalThis.fetch, now?: () => number}} opts
   */
  constructor(opts) {
    this.endpoint = resolveEndpoint(opts.endpoint);
    this.operatorToken = opts.operatorToken;
    this.identityCredential = opts.identityCredential;
    /** Human-readable account this connection acts as, when the host knows it. */
    this.accountLabel = opts.accountLabel;
    this.apiKey = opts.apiKey;
    this.idpAssertion = opts.idpAssertion;
    this.userId = opts.userId;
    this.principalId = opts.principalId;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    /** @type {{userId: string, principalId: string, token: string, expiresAtMs: number} | null} */
    this.identity = null;
    /** @type {Promise<{userId: string, principalId: string, token: string, expiresAtMs: number}> | null} */
    this.identityPromise = null;
    /** @type {Map<string, {token: string, expiresAtMs: number}>} workspace id → owner Biscuit */
    this.biscuits = new Map();
    /** @type {Map<string, Promise<string>>} workspace id → in-flight mint */
    this.biscuitPromises = new Map();
  }

  async request(
    method,
    path,
    {
      body,
      bearer,
      signal,
      timeoutMs = REQUEST_TIMEOUT_MS,
      maxResponseBytes = MAX_RESPONSE_BODY_BYTES,
    } = {},
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`request timeout must be positive; got ${timeoutMs}`);
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
      throw new Error(`response byte limit must be a non-negative safe integer; got ${maxResponseBytes}`);
    }

    const operation = `${method} ${String(path).split('?', 1)[0]}`;
    const abort = new AbortController();
    let timedOut = false;
    let cancelledByCaller = false;
    const cancel = () => {
      if (abort.signal.aborted) return;
      cancelledByCaller = true;
      abort.abort(signal?.reason);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      if (abort.signal.aborted) return;
      timedOut = true;
      abort.abort(new Error(`request deadline exceeded after ${timeoutMs} ms`));
    }, timeoutMs);

    let res;
    let text;
    try {
      res = await this.fetch(`${this.endpoint}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abort.signal,
      });
      text = await readResponseText(res, maxResponseBytes, abort.signal);
    } catch (err) {
      const cause = providerSafeCause(err);
      if (err instanceof ResponseLimitError) {
        throw new Error(
          `control plane response to ${operation} exceeded ${maxResponseBytes} bytes; ` +
            'the operation may have completed, but its result was not read — do not retry a non-idempotent request blindly',
          { cause },
        );
      }
      if (timedOut) {
        throw new Error(
          `control plane request ${operation} timed out after ${timeoutMs} ms; ` +
            'whether the operation completed is UNKNOWN — do not retry a non-idempotent request blindly',
          { cause },
        );
      }
      if (cancelledByCaller) {
        throw new Error(
          `control plane request ${operation} was cancelled by the caller; ` +
            'whether the operation completed is UNKNOWN',
          { cause },
        );
      }
      throw new Error(
        `control plane request ${operation} failed before a complete response (${describeErrorClass(err)}); ` +
          'whether the operation completed is UNKNOWN',
        { cause },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }

    let parsed = {};
    let parseFailed = false;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A body that is not JSON is what the extractor produces for a
        // malformed request (§7 conventions) — keep the text, do not pretend.
        parseFailed = true;
        parsed = { error: 'unparseable_body', detail: text.slice(0, 500) };
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(res.status, parsed.error ?? 'unknown', parsed);
    }
    if (parseFailed) {
      throw new Error(
        `control plane returned HTTP ${res.status} with a non-JSON body for ${operation}; ` +
          'the operation may have completed, but its result is unusable — do not retry blindly',
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `unexpected response shape from ${operation}: expected a JSON object, got ${describeValue(parsed)}`,
      );
    }
    return parsed;
  }

  /**
   * Exchange the operator credential for a user-scoped identity token
   * (ADR-0034). Identity tokens last an hour; this refreshes a minute early
   * rather than discovering the expiry inside somebody's tool call.
   */
  async identityToken() {
    const now = this.now();
    if (this.identity && this.identity.expiresAtMs - IDENTITY_SKEW_MS > now) {
      return this.identity;
    }
    if (this.identityPromise) return this.identityPromise;
    this.identityPromise = this.exchangeIdentity();
    try {
      return await this.identityPromise;
    } finally {
      this.identityPromise = null;
    }
  }

  async exchangeIdentity() {
    // Precedence is narrowest-first, which is also production-first. A
    // per-user identity credential (ADR-0062) names exactly one user and
    // principal and can do nothing else; an operator credential is the
    // laptop's broader one; an IdP assertion is dev and the IdP integration.
    if (this.identityCredential) return this.identityFromCredential();
    if (!this.operatorToken) return this.identityFromAssertion();
    const body = await this.request('POST', '/v1/operator/session', {
      body: {},
      bearer: this.operatorToken,
    });
    this.identity = identitySession(body, 'POST /v1/operator/session', this.now());
    return this.identity;
  }

  /**
   * ADR-0062's door, and **the credential a real user will hold**. A per-user
   * bearer registered at provisioning, carrying the `identity` scope: the row
   * names one user and one principal, and supplies both — no request field
   * does, so this credential cannot ask for anyone else's workspaces. The
   * ordinary operator authenticator refuses a scoped row everywhere else.
   *
   * This is the shape an OAuth layer hands down. The hosted endpoint resolves
   * a signed-in account to its credential and exchanges it here; nothing about
   * the authorization model is special-cased for a remote caller.
   */
  async identityFromCredential() {
    const body = await this.request('POST', '/v1/identity/session', {
      body: {},
      bearer: this.identityCredential,
    });
    this.identity = identitySession(body, 'POST /v1/identity/session', this.now());
    return this.identity;
  }

  /**
   * The other way to the same user-scoped identity token (I6): what an IdP
   * vouches for, exchanged directly. This is the dev path and the path an IdP
   * integration uses; the operator credential exists so a laptop does not have
   * to hold one of these.
   *
   * The route returns no expiry, so the documented TTL is assumed rather than
   * read. That assumption is safe in one direction only — refreshing early
   * costs a round trip, refreshing late costs a failed tool call — so it is
   * deliberately conservative.
   */
  async identityFromAssertion() {
    if (!this.idpAssertion) {
      throw new Error(
        'no credential. Set one of, narrowest first: REACHPAD_IDENTITY_CREDENTIAL (per-user, ADR-0062) · REACHPAD_OPERATOR_TOKEN (the laptop credential) · REACHPAD_IDP_ASSERTION with REACHPAD_USER_ID (dev and IdP integrations)',
      );
    }
    if (!this.userId) throw new Error('REACHPAD_IDP_ASSERTION requires REACHPAD_USER_ID');
    const body = await this.request('POST', '/v1/identity/tokens', {
      body: {
        user_id: this.userId,
        principal_id: this.principalId ?? 'dev-principal',
        idp_assertion: this.idpAssertion,
      },
    });
    requireString(body, 'identity_token', 'POST /v1/identity/tokens');
    this.identity = {
      userId: this.userId,
      principalId: this.principalId ?? 'dev-principal',
      token: body.identity_token,
      expiresAtMs: this.now() + 45 * 60_000,
    };
    return this.identity;
  }

  /** POST /v1/workspaces → { id, name, biscuit } */
  async createWorkspace(name) {
    const identity = await this.identityToken();
    const requestedName = typeof name === 'string' ? name.trim() : '';
    const body = await this.request('POST', '/v1/workspaces', {
      body: {
        user_id: identity.userId,
        identity_token: identity.token,
        ...(requestedName ? { name: requestedName } : {}),
      },
    });
    const id = body.workspace?.id;
    const createdName = body.workspace?.name;
    if (!id) throw new Error('unexpected response shape: workspace.id missing');
    if (!createdName) throw new Error('unexpected response shape: workspace.name missing');
    if (body.biscuit !== undefined) {
      this.biscuits.set(
        id,
        biscuitSession(body, 'POST /v1/workspaces', this.now()),
      );
    }
    return { id, name: createdName, biscuit: body.biscuit };
  }

  /** GET /v1/workspaces?user_id=… */
  async listWorkspaces() {
    const identity = await this.identityToken();
    const path = `/v1/workspaces?user_id=${encodeURIComponent(identity.userId)}`;
    const body = await this.request('GET', path, { bearer: identity.token });
    const workspaces = requireArray(body, 'workspaces', 'GET /v1/workspaces');
    return workspaces.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      forks: Array.isArray(row.forks) ? row.forks.length : 0,
      archived_at_ms: row.archived_at_ms ?? null,
    }));
  }

  /** Account-authorized, fleet-authoritative compute-credit balance. */
  async creditBalance() {
    const identity = await this.identityToken();
    const body = await this.request('POST', '/v1/credits/balance', {
      body: { user_id: identity.userId, identity_token: identity.token },
    });
    requireFiniteNumber(body, 'balance_millicredits', 'POST /v1/credits/balance');
    return body;
  }

  /**
   * The owner Biscuit for a workspace this process did not create.
   * `POST /v1/workspaces/:id/token` mints one from the identity token, which
   * is how a fresh process acts on an workspace created last week.
   */
  async biscuitFor(workspace) {
    const cached = this.biscuits.get(workspace);
    if (cached && cached.expiresAtMs - BISCUIT_SKEW_MS > this.now()) return cached.token;
    if (cached) this.biscuits.delete(workspace);
    const pending = this.biscuitPromises.get(workspace);
    if (pending) return pending;
    const mint = (async () => {
      const identity = await this.identityToken();
      const body = await this.request('POST', `/v1/workspaces/${encodeURIComponent(workspace)}/token`, {
        body: { user_id: identity.userId, identity_token: identity.token },
      });
      const session = biscuitSession(
        body,
        'POST /v1/workspaces/:id/token',
        this.now(),
      );
      this.biscuits.set(workspace, session);
      return session.token;
    })();
    this.biscuitPromises.set(workspace, mint);
    try {
      return await mint;
    } finally {
      if (this.biscuitPromises.get(workspace) === mint) this.biscuitPromises.delete(workspace);
    }
  }

  /** GET /v1/workspaces/:id/lineage */
  async lineage(workspace) {
    // controld accepts this read Biscuit as a bearer credential. Never put a
    // capability in the URL: query strings escape into access logs, proxy
    // diagnostics, browser history, and tracing spans even when errors here
    // are carefully sanitized.
    return this.withBiscuitRead(workspace, (biscuit) =>
      this.request('GET', `/v1/workspaces/${encodeURIComponent(workspace)}/lineage`, {
        bearer: biscuit,
      }),
    );
  }

  /** POST /v1/workspaces/:id/fork */
  async fork(workspace, name) {
    const biscuit = await this.biscuitFor(workspace);
    return this.request('POST', `/v1/workspaces/${encodeURIComponent(workspace)}/fork`, {
      body: { biscuit, ...(name ? { name } : {}) },
    });
  }

  /**
   * `GET /v1/workspaces/:id` — state, and the lease if one is held.
   *
   * The only route that reports whether an workspace is RUNNING. `lineage`
   * answers what it boots from, and `list` answers what exists; neither
   * answers the question a caller about to pause, archive or share a port
   * actually has.
   */
  async workspaceStatus(workspace) {
    const body = await this.withBiscuitRead(workspace, (biscuit) =>
      this.request('GET', `/v1/workspaces/${encodeURIComponent(workspace)}`, {
        bearer: biscuit,
      }),
    );
    return {
      id: body.workspace?.id ?? workspace,
      name: body.workspace?.name ?? '',
      state: body.state ?? 'unknown',
      lease: body.lease
        ? {
            node: body.lease.node ?? '',
            fencingToken: body.lease.fencing_token ?? null,
          }
        : null,
    };
  }

  /**
   * `POST /v1/workspaces/:id/release` — end the lease, sealing first.
   *
   * The fencing token is not optional and not guessable: it comes from the
   * status read immediately before (I2). A stale one is refused rather than
   * applied, which is the whole point of it — two callers racing to pause the
   * same workspace must not both succeed.
   *
   * `discard` is never set true here. The MCP surface has no verb that means
   * "throw away everything since the last save", and adding one by default
   * argument is how an agent loses a customer's work.
   */
  async release(workspace, fencingToken) {
    const biscuit = await this.biscuitFor(workspace);
    return this.request('POST', `/v1/workspaces/${encodeURIComponent(workspace)}/release`, {
      body: { biscuit, fencing_token: fencingToken, discard: false },
    });
  }

  /**
   * `POST /v1/workspaces/:id/port-shares` — open a port to the preview plane.
   *
   * Naturally idempotent per live `(workspace, port)`: a second call for a
   * port that is already open returns the SAME token rather than minting a
   * second one, so it is safe to re-run when the state is unknown.
   */
  async createPortShare(workspace, port) {
    const { bearer, biscuit } = await this.portShareAuth(workspace);
    const body = await this.request(
      'POST',
      `/v1/workspaces/${encodeURIComponent(workspace)}/port-shares`,
      { body: { ...(biscuit ? { biscuit } : {}), port }, bearer },
    );
    const share = body.port_share;
    if (!share) throw new Error('unexpected response shape: port_share missing');
    return share;
  }

  /**
   * `GET /v1/workspaces/:id/port-shares` — the LIVE shares, oldest first.
   *
   * Unlike its two siblings this route reads the Biscuit off the header, not
   * the body: it is a GET and has none. Getting that wrong is a
   * `400 bad_token_encoding`, which reads like a broken credential rather
   * than a misplaced one.
   */
  async listPortShares(workspace) {
    if (!this.apiKey) {
      const body = await this.withBiscuitRead(workspace, (biscuit) =>
        this.request('GET', `/v1/workspaces/${encodeURIComponent(workspace)}/port-shares`, {
          bearer: biscuit,
        }),
      );
      return requireArray(body, 'port_shares', 'GET /v1/workspaces/:id/port-shares');
    }
    const { bearer, biscuit } = await this.portShareAuth(workspace);
    const body = await this.request(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspace)}/port-shares`,
      { bearer: bearer ?? biscuit },
    );
    return requireArray(body, 'port_shares', 'GET /v1/workspaces/:id/port-shares');
  }

  /**
   * Retry one read after the server explicitly rejects a cached Biscuit. The
   * live service deliberately folds expiry into `403 not_authorized`; a
   * re-mint can repair that. Mutations never use this helper because an
   * ambiguous retry could apply an operation twice.
   */
  async withBiscuitRead(workspace, read) {
    const biscuit = await this.biscuitFor(workspace);
    try {
      return await read(biscuit);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 403 || err.code !== 'not_authorized') {
        throw err;
      }
      const cached = this.biscuits.get(workspace);
      if (cached?.token === biscuit) this.biscuits.delete(workspace);
      return read(await this.biscuitFor(workspace));
    }
  }

  /** `POST /v1/workspaces/:id/port-shares/revoke` — close one port. */
  async revokePortShare(workspace, port) {
    const { bearer, biscuit } = await this.portShareAuth(workspace);
    return this.request(
      'POST',
      `/v1/workspaces/${encodeURIComponent(workspace)}/port-shares/revoke`,
      { body: { ...(biscuit ? { biscuit } : {}), port }, bearer },
    );
  }

  /**
   * How the three port-share routes authenticate, which is not how the rest
   * of this client does.
   *
   * They accept an `rpak1.…` key off the HEADER and mint a Biscuit from it
   * server-side (`port_shares.rs::credential`), so a deployment holding only
   * `REACHPAD_API_KEY` — no identity credential at all — can still open a
   * port. Falling through to `biscuitFor` in that case would fail at the
   * identity exchange rather than at the thing the caller asked for.
   *
   * The key must carry `--role owner`. A `collaborator` key is refused with
   * `not_owner`: listing hands back live tokens, which are capabilities.
   */
  async portShareAuth(workspace) {
    if (this.apiKey) return { bearer: this.apiKey, biscuit: null };
    return { bearer: undefined, biscuit: await this.biscuitFor(workspace) };
  }

  /** POST /v1/workspaces/:id/archive */
  async archive(workspace) {
    const biscuit = await this.biscuitFor(workspace);
    return this.request('POST', `/v1/workspaces/${encodeURIComponent(workspace)}/archive`, {
      body: { biscuit },
    });
  }

  /**
   * POST /v1/workspaces/:id/exec — the NDJSON stream, read the way §5.2 says
   * it must be read:
   *
   * - the terminal line is `exec.end`, and the HTTP status is not a verdict;
   * - a stream that ends without one is a FAILURE, never a zero exit;
   * - `exec.waiting` is a resume in progress, not an error;
   * - the caller applies its own deadline, because a node can wait 90 s for a
   *   guest link while this connection dies at 30 (M4 §27.2, open).
   *
   * @param {string} workspace
   * @param {{argv: string[], cwd?: string, env?: Record<string,string>, timeoutMs?: number}} spec
   */
  async exec(workspace, spec) {
    const timeoutMs = spec.timeoutMs ?? MAX_EXEC_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_EXEC_TIMEOUT_MS
    ) {
      throw new Error(
        `exec timeout must be a safe integer between 1 and ${MAX_EXEC_TIMEOUT_MS} ms`,
      );
    }
    const body = { argv: spec.argv, env: spec.env ?? {} };
    if (spec.cwd) body.cwd = spec.cwd;
    if (spec.timeoutMs !== undefined) body.timeout_ms = timeoutMs;

    let bearer = this.apiKey;
    if (!bearer) body.biscuit = await this.biscuitFor(workspace);

    // Our own deadline, and it must be LOOSER than controld's or it defeats
    // its own purpose: it exists to turn a hang the server will never answer
    // into a legible failure, not to abandon an exec the server is still about
    // to answer. controld holds the stream for `timeout_ms +
    // EXEC_STREAM_GRACE_MS` (150 s, bins/controld/src/execbroker.rs), so this
    // sits past that with room for the round trip. Measured against a real
    // controld: a lease granted to a node that never claims the work produces
    // no terminal event until that grace elapses.
    const deadlineMs = timeoutMs + EXEC_GRACE_MS + 15_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadlineMs);

    const stdout = new TailBuffer(MAX_EXEC_OUTPUT_BYTES);
    const stderr = new TailBuffer(MAX_EXEC_OUTPUT_BYTES);
    let waited = false;
    let end = null;
    let refusal = null;

    try {
      const res = await this.fetch(
        `${this.endpoint}/v1/workspaces/${encodeURIComponent(workspace)}/exec`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify(body),
          signal: abort.signal,
        },
      );

      for await (const line of ndjson(res.body, {
        maxLineBytes: MAX_EXEC_EVENT_BYTES,
        signal: abort.signal,
      })) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        switch (value.ev) {
          case 'exec.out': {
            const target = value.fd === 2 ? stderr : stdout;
            if (typeof value.data_b64 === 'string') {
              target.push(Buffer.from(value.data_b64, 'base64'));
            }
            break;
          }
          case 'exec.waiting':
            waited = true;
            break;
          case 'exec.end':
            end = value;
            break;
          default:
            if (value.error) refusal = { status: res.status, ...value };
        }
      }

      if (end) {
        return {
          exit_code: end.exit_code ?? null,
          signal: end.signal ?? null,
          duration_ms: end.duration_ms ?? null,
          truncated: Boolean(end.truncated),
          timed_out: Boolean(end.timed_out),
          resumed: waited,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          stdout_dropped_bytes: stdout.dropped,
          stderr_dropped_bytes: stderr.dropped,
        };
      }
      if (refusal) {
        throw execRefusal(refusal.status, refusal);
      }
      throw new ExecIncompleteError(
        'the exec stream ended without `exec.end`. Whether the command ran is UNKNOWN — this is not a zero exit and must not be treated as one.',
      );
    } catch (err) {
      if (err instanceof NdjsonLineLimitError) {
        throw new Error(
          `exec stream event exceeded ${MAX_EXEC_EVENT_BYTES} bytes; ` +
            'whether the command ran is UNKNOWN — the oversized response was cancelled',
          { cause: err },
        );
      }
      if (err?.name === 'AbortError') {
        throw new Error(
          `no result within ${deadlineMs} ms and the stream never terminated; whether the command ran is UNKNOWN`,
        );
      }
      if (err instanceof ApiError || err instanceof ExecIncompleteError) throw err;
      const cause = providerSafeCause(err);
      throw new Error(
        `control plane exec failed before a complete result (${describeErrorClass(err)}); ` +
          'whether the command ran is UNKNOWN',
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

class ResponseLimitError extends Error {
  constructor(limit) {
    super(`response body exceeds ${limit} bytes`);
    this.name = 'ResponseLimitError';
  }
}

class NdjsonLineLimitError extends Error {
  constructor(limit) {
    super(`NDJSON line exceeds ${limit} bytes`);
    this.name = 'NdjsonLineLimitError';
  }
}

class ExecIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecIncompleteError';
  }
}

const EXEC_REFUSAL_CODES = new Set([
  'api_key_expired',
  'api_key_out_of_scope',
  'api_key_revoked',
  'api_key_unknown',
  'empty_argv',
  'exec_concurrency_exceeded',
  'no_authority',
  'no_capacity',
  'not_authorized',
  'workspace_archived',
  'workspace_not_found',
  'workspace_stopping',
  'workspace_unavailable',
]);

function execRefusal(status, value) {
  const code = EXEC_REFUSAL_CODES.has(value.error) ? value.error : 'unknown';
  const body = {};
  for (const field of ['exec_max_concurrent', 'running', 'retry_after_ms']) {
    if (typeof value[field] === 'number' && Number.isFinite(value[field])) {
      body[field] = value[field];
    }
  }
  if (code === 'no_capacity' && ['all_full', 'draining'].includes(value.cause)) {
    body.cause = value.cause;
  }
  return new ApiError(status, code, body);
}

async function readResponseText(response, limit, signal) {
  const announced = response.headers?.get?.('content-length');
  if (/^\d+$/.test(announced ?? '') && Number(announced) > limit) {
    void response.body?.cancel?.(new ResponseLimitError(limit)).catch(() => {});
    throw new ResponseLimitError(limit);
  }
  if (!response.body) return '';

  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new Error('response read aborted');
      if (done) break;
      const chunk = Buffer.from(value);
      if (!chunk.length) continue;
      size += chunk.length;
      if (size > limit) {
        // Do not await a provider-controlled stream's cancel hook: a broken
        // hook must not turn the memory bound itself into an unbounded wait.
        void reader.cancel(new ResponseLimitError(limit)).catch(() => {});
        throw new ResponseLimitError(limit);
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.size = 0;
    this.dropped = 0;
  }

  push(value) {
    const chunk = Buffer.from(value);
    // Empty exec.out events are legal but must not grow the chunk index.
    if (!chunk.length) return;
    if (chunk.length >= this.limit) {
      this.dropped += this.size + chunk.length - this.limit;
      // Copy the tail: a slice would keep an arbitrarily large source Buffer
      // alive even though only the bounded suffix is useful.
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.limit))];
      this.size = this.limit;
      return;
    }

    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit) {
      const excess = this.size - this.limit;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
        this.dropped += first.length;
      } else {
        this.chunks[0] = Buffer.from(first.subarray(excess));
        this.size -= excess;
        this.dropped += excess;
      }
    }
  }

  toString() {
    return Buffer.concat(this.chunks, this.size).toString('utf8');
  }
}

function identitySession(body, operation, now) {
  const expiresAtMs = requireFiniteNumber(body, 'expires_at_ms', operation);
  if (expiresAtMs - IDENTITY_SKEW_MS <= now) {
    throw new Error(
      `unexpected response shape from ${operation}: expires_at_ms must remain valid for more than ${IDENTITY_SKEW_MS} ms`,
    );
  }
  return {
    userId: requireString(body, 'user_id', operation),
    principalId: requireString(body, 'principal_id', operation),
    token: requireString(body, 'identity_token', operation),
    expiresAtMs,
  };
}

function biscuitSession(body, operation, now) {
  const tokenField = body.biscuit !== undefined ? 'biscuit' : 'token';
  const token = requireString(body, tokenField, operation);
  const expiresAtMs = requireFiniteNumber(body, 'expires_at_ms', operation);
  if (expiresAtMs - BISCUIT_SKEW_MS <= now) {
    throw new Error(
      `unexpected response shape from ${operation}: expires_at_ms must remain valid for more than ${BISCUIT_SKEW_MS} ms`,
    );
  }
  return { token, expiresAtMs };
}

function requireString(body, field, operation) {
  const value = body[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(
      `unexpected response shape from ${operation}: ${field} must be a non-empty string`,
    );
  }
  return value;
}

function requireArray(body, field, operation) {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new Error(`unexpected response shape from ${operation}: ${field} must be an array`);
  }
  return value;
}

function requireFiniteNumber(body, field, operation) {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`unexpected response shape from ${operation}: ${field} must be a finite number`);
  }
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeErrorClass(error) {
  const cause = providerSafeCause(error);
  return cause.code ? `${cause.name}, ${cause.code}` : cause.name;
}

/**
 * Fetch implementations often put the complete URL — and some wrappers put
 * request headers — into an error message and stack. Forwarding either could
 * turn a network failure into credential or account disclosure. Retain only a
 * conventional error class and machine code; both are allowlisted.
 */
function providerSafeCause(error) {
  const rawName = typeof error?.name === 'string' ? error.name : '';
  const name = SAFE_ERROR_NAMES.has(rawName) ? rawName : 'Error';
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = SAFE_ERROR_CODES.has(rawCode) ? rawCode : undefined;
  const safe = new Error(code ? `${name} (${code})` : name);
  safe.name = name;
  if (code) safe.code = code;
  return safe;
}

const SAFE_ERROR_NAMES = new Set([
  'AbortError',
  'DOMException',
  'Error',
  'FetchError',
  'RangeError',
  'SystemError',
  'TypeError',
]);
const SAFE_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * The two numbers this client mirrors out of controld, exported so the drift
 * guard can assert they still match their source. A mirrored constant with no
 * guard is a comment that used to be true.
 */
export const MIRRORED = {
  EXEC_STREAM_GRACE_MS: EXEC_GRACE_MS,
  DEFAULT_EXEC_TIMEOUT_MS: MAX_EXEC_TIMEOUT_MS,
};

export const _internal = {
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_EXEC_EVENT_BYTES,
  TailBuffer,
  ndjson,
};

/**
 * Split a web byte stream into newline-delimited strings while bounding the
 * raw bytes retained for any one event. Bytes are joined before UTF-8 decode,
 * so a multibyte code point split across chunks is neither corrupted nor
 * under-counted. A final unterminated event is accepted at or below the cap.
 */
async function* ndjson(
  stream,
  { maxLineBytes = MAX_EXEC_EVENT_BYTES, signal } = {},
) {
  if (!stream) return;

  const reader = stream.getReader();
  /** @type {Buffer[]} */
  let pending = [];
  let pendingBytes = 0;
  let completed = false;
  let cancelRequested = false;
  const cancel = (reason) => {
    if (cancelRequested) return;
    cancelRequested = true;
    void reader.cancel(reason).catch(() => {});
  };
  const onAbort = () => cancel(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  const append = (part) => {
    if (pendingBytes + part.length > maxLineBytes) {
      const failure = new NdjsonLineLimitError(maxLineBytes);
      cancel(failure);
      throw failure;
    }
    if (!part.length) return;
    // A slice can retain its source chunk. Copy so the pending-line bound is
    // also a bound on what this parser itself keeps alive between reads.
    pending.push(Buffer.from(part));
    pendingBytes += part.length;
  };
  const takeLine = () => {
    const line = Buffer.concat(pending, pendingBytes).toString('utf8').trim();
    pending = [];
    pendingBytes = 0;
    return line;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      if (done) {
        completed = true;
        break;
      }

      const chunk = Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        append(chunk.subarray(offset, end));
        if (newline < 0) break;
        const line = takeLine();
        if (line) yield line;
        offset = newline + 1;
      }
    }
    if (pendingBytes) {
      const line = takeLine();
      if (line) yield line;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!completed) cancel(new Error('NDJSON consumer stopped before the response ended'));
    reader.releaseLock();
  }
}
