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
const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/** @param {string} raw */
export function resolveEndpoint(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('no endpoint: set REACHPAD_ENDPOINT');
  const url = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(url);
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
   *          fetch?: typeof globalThis.fetch}} opts
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
    /** @type {{userId: string, principalId: string, token: string, expiresAtMs: number} | null} */
    this.identity = null;
    /** @type {Map<string, string>} workspace id → owner Biscuit */
    this.biscuits = new Map();
  }

  async request(method, path, { body, bearer, signal } = {}) {
    const res = await this.fetch(`${this.endpoint}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A body that is not JSON is what the extractor produces for a
        // malformed request (§7 conventions) — keep the text, do not pretend.
        parsed = { error: 'unparseable_body', detail: text.slice(0, 500) };
      }
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(res.status, parsed.error ?? 'unknown', parsed);
    }
    return parsed;
  }

  /**
   * Exchange the operator credential for a user-scoped identity token
   * (ADR-0034). Identity tokens last an hour; this refreshes a minute early
   * rather than discovering the expiry inside somebody's tool call.
   */
  async identityToken() {
    const now = Date.now();
    if (this.identity && this.identity.expiresAtMs - IDENTITY_SKEW_MS > now) {
      return this.identity;
    }
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
    this.identity = {
      userId: body.user_id,
      principalId: body.principal_id,
      token: body.identity_token,
      expiresAtMs: Number(body.expires_at_ms ?? 0),
    };
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
    this.identity = {
      userId: body.user_id,
      principalId: body.principal_id,
      token: body.identity_token,
      expiresAtMs: Number(body.expires_at_ms ?? 0),
    };
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
    if (!body.identity_token) throw new Error('unexpected response shape: identity_token missing');
    this.identity = {
      userId: this.userId,
      principalId: this.principalId ?? 'dev-principal',
      token: body.identity_token,
      expiresAtMs: Date.now() + 45 * 60_000,
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
    if (body.biscuit) this.biscuits.set(id, body.biscuit);
    return { id, name: createdName, biscuit: body.biscuit };
  }

  /** GET /v1/workspaces?user_id=… */
  async listWorkspaces() {
    const identity = await this.identityToken();
    const path = `/v1/workspaces?user_id=${encodeURIComponent(identity.userId)}`;
    const body = await this.request('GET', path, { bearer: identity.token });
    return (body.workspaces ?? []).map((row) => ({
      id: row.id,
      name: row.name ?? '',
      forks: Array.isArray(row.forks) ? row.forks.length : 0,
      archived_at_ms: row.archived_at_ms ?? null,
    }));
  }

  /** Account-authorized, fleet-authoritative compute-credit balance. */
  async creditBalance() {
    const identity = await this.identityToken();
    return this.request('POST', '/v1/credits/balance', {
      body: { user_id: identity.userId, identity_token: identity.token },
    });
  }

  /**
   * The owner Biscuit for a workspace this process did not create.
   * `POST /v1/workspaces/:id/token` mints one from the identity token, which
   * is how a fresh process acts on an environment created last week.
   */
  async biscuitFor(workspace) {
    const cached = this.biscuits.get(workspace);
    if (cached) return cached;
    const identity = await this.identityToken();
    const body = await this.request('POST', `/v1/workspaces/${encodeURIComponent(workspace)}/token`, {
      body: { user_id: identity.userId, identity_token: identity.token },
    });
    const biscuit = body.biscuit ?? body.token;
    if (!biscuit) throw new Error('unexpected response shape: no biscuit in workspace token');
    this.biscuits.set(workspace, biscuit);
    return biscuit;
  }

  /** GET /v1/workspaces/:id/lineage */
  async lineage(workspace) {
    const biscuit = await this.biscuitFor(workspace);
    const path = `/v1/workspaces/${encodeURIComponent(workspace)}/lineage?biscuit=${encodeURIComponent(biscuit)}`;
    return this.request('GET', path);
  }

  /** POST /v1/workspaces/:id/fork */
  async fork(workspace, name) {
    const biscuit = await this.biscuitFor(workspace);
    return this.request('POST', `/v1/workspaces/${encodeURIComponent(workspace)}/fork`, {
      body: { biscuit, ...(name ? { name } : {}) },
    });
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
    const body = { argv: spec.argv, env: spec.env ?? {} };
    if (spec.cwd) body.cwd = spec.cwd;
    if (spec.timeoutMs) body.timeout_ms = spec.timeoutMs;

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
    const deadlineMs = (spec.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) + EXEC_GRACE_MS + 15_000;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), deadlineMs);

    const stdout = [];
    const stderr = [];
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

      for await (const line of ndjson(res.body)) {
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
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        };
      }
      if (refusal) {
        throw new ApiError(refusal.status, refusal.error, refusal);
      }
      throw new Error(
        'the exec stream ended without `exec.end`. Whether the command ran is UNKNOWN — this is not a zero exit and must not be treated as one.',
      );
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(
          `no result within ${deadlineMs} ms and the stream never terminated; whether the command ran is UNKNOWN`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The two numbers this client mirrors out of controld, exported so the drift
 * guard can assert they still match their source. A mirrored constant with no
 * guard is a comment that used to be true.
 */
export const MIRRORED = {
  EXEC_STREAM_GRACE_MS: EXEC_GRACE_MS,
  DEFAULT_EXEC_TIMEOUT_MS,
};

/** Split a byte stream into newline-delimited strings, last partial dropped. */
async function* ndjson(stream) {
  if (!stream) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
    }
  }
  const rest = buffer.trim();
  if (rest) yield rest;
}
