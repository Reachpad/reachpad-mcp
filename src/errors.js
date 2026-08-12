/**
 * Refusal rendering (ADR-0066 §4, second rule): return REMEDIES, not codes.
 *
 * Every controld refusal is `{"error":"<code>"}` plus, for the ones that
 * matter, fields naming the limit and what to do about it. An agent handed
 * `entitlement_limit` learns nothing; an agent handed "you have 3 of 3 live
 * environments; archive one" acts. The numbers come from the server — this
 * module never invents one, because I13 says the entitlement is policy and a
 * hardcoded limit here would be a lie the moment policy changed.
 */

/** Sentences for codes a caller of this surface can actually meet. */
const SENTENCE = {
  entitlement_limit: 'You are at your plan limit.',
  no_entitlement: 'This account has no entitlement for that.',
  exec_concurrency_exceeded: 'Too many commands are already running in this environment.',
  no_capacity: 'The fleet has no room for this environment right now.',
  workspace_stopping: 'The environment is sealing on its way down.',
  workspace_archived: 'That environment is archived; nothing is deleted, but it cannot be used.',
  workspace_not_found: 'No such environment (or it belongs to another account).',
  lease_held: 'Another node holds this environment.',
  node_draining: 'The node running this environment is being drained.',
  workspace_unavailable: 'The environment is between homes; retrying takes the paused path.',
  empty_argv: 'A command needs at least one argument.',
  api_key_expired: 'That API key has expired.',
  api_key_revoked: 'That API key was revoked.',
  api_key_out_of_scope: 'That API key does not name this environment.',
  api_key_unknown: 'No such API key.',
  no_authority: 'No credential was presented.',
  not_authorized: 'That credential does not permit this here.',
  operator_token_revoked: 'The operator credential was revoked.',
  core_state_contended: 'The control plane was contended.',
};

/**
 * Fields the server attaches to a refusal, in the order they read best.
 * Listed explicitly rather than dumping the body, so a future field carrying
 * something sensitive is not forwarded to a model by accident.
 */
const REMEDY_FIELDS = [
  'remedy',
  'cause',
  'max_workspaces',
  'live_workspaces',
  'max_concurrent',
  'active_leases',
  'sealing_leases',
  'exec_max_concurrent',
  'running',
  'retry_after_ms',
  'holder_node',
  'presented',
  'current',
  'allowed',
  'key_id',
  'still_placed',
  'detail',
];

/** A refusal the caller can act on: what happened, the numbers, the code. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {Record<string, unknown>} body
   */
  constructor(status, code, body = {}) {
    super(render(status, code, body));
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** @returns {string} one line a model can act on, numbers included. */
export function render(status, code, body = {}) {
  const parts = [SENTENCE[code] ?? `The control plane refused this (${code}).`];
  const facts = [];
  for (const field of REMEDY_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === '') continue;
    facts.push(`${field}=${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  if (facts.length) parts.push(facts.join(' '));
  parts.push(`[${status} ${code}]`);
  return parts.join(' ');
}
