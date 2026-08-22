/**
 * The agent-facing surface (ADR-0066 §4). SMALLER than the API on purpose:
 * six tools, each a translation of routes that exist today. Nothing here
 * advertises a capability the fleet does not have — a tool that always fails
 * costs a model a turn and teaches it to distrust the rest.
 *
 * Deliberately absent, and named in the README so their absence is a decision
 * rather than an oversight: `expose_port` (needs the `tcp` channel kind, ADR
 * §6) and `start_agent` (needs a harness route, ADR §5).
 */

const OUTPUT_BUDGET = 4_000;

/** Trim to the tail — the end of a build log is where the failure is. */
function tail(text, budget = OUTPUT_BUDGET) {
  if (text.length <= budget) return { text, dropped: 0 };
  return { text: text.slice(text.length - budget), dropped: text.length - budget };
}

function renderExec(result) {
  const out = tail(result.stdout);
  const err = tail(result.stderr);
  const lines = [];
  lines.push(
    result.exit_code === null
      ? `killed by ${result.signal ?? 'a signal'} after ${result.duration_ms ?? '?'} ms`
      : `exit ${result.exit_code} after ${result.duration_ms ?? '?'} ms`,
  );
  if (result.resumed) lines.push('(the environment was paused and resumed to run this)');
  if (result.timed_out) lines.push('TIMED OUT — the command did not finish');
  if (result.truncated) lines.push('output hit the entitlement cap and was truncated server-side');
  if (out.text) lines.push(`--- stdout${out.dropped ? ` (first ${out.dropped} bytes dropped)` : ''} ---\n${out.text}`);
  if (err.text) lines.push(`--- stderr${err.dropped ? ` (first ${err.dropped} bytes dropped)` : ''} ---\n${err.text}`);
  if (!out.text && !err.text) lines.push('(no output)');
  return lines.join('\n');
}

/**
 * @param {import('./client.js').ControlClient} client
 */
export function buildTools(client) {
  return [
    {
      name: 'create_environment',
      title: 'Create environment',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Create a persistent development environment: a filesystem and processes that survive between calls. Optionally clone a git repository into it. Returns the environment id used by every other tool.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable name, e.g. the repo or task.' },
          repo: {
            type: 'string',
            description: 'Optional git URL to clone into /work. Must be reachable without credentials unless the account has a mirror for it.',
          },
          ref: { type: 'string', description: 'Optional branch or tag to check out.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async handler({ name, repo, ref }) {
        const created = await client.createWorkspace(name);
        const lines = [`environment ${created.id} created (name: ${name})`];
        if (repo) {
          const argv = ['/bin/sh', '-lc', cloneScript(repo, ref)];
          const result = await client.exec(created.id, { argv, timeoutMs: 300_000 });
          lines.push(
            result.exit_code === 0
              ? `cloned ${repo}${ref ? ` at ${ref}` : ''} into /work`
              : `clone FAILED — the environment exists and is usable, but /work is not populated:\n${renderExec(result)}`,
          );
        }
        return lines.join('\n');
      },
    },

    {
      name: 'list_environments',
      title: 'List environments',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'List this account\'s environments, with how many forks each has.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const rows = await client.listWorkspaces();
        // The account leads, and it leads on the EMPTY answer especially: "no
        // environments" and "no environments for THIS account" are different
        // sentences, and only the second one lets someone spot a wrong login.
        const who = client.accountLabel ? `account: ${client.accountLabel}\n` : '';
        if (!rows.length) return `${who}No environments yet.`;
        return who + rows
          .map((row) => {
            const bits = [row.id, row.name || '(unnamed)'];
            if (row.forks) bits.push(`${row.forks} fork${row.forks === 1 ? '' : 's'}`);
            if (row.archived_at_ms) bits.push('archived');
            return bits.join('  ');
          })
          .join('\n');
      },
    },

    {
      name: 'get_environment',
      title: 'Inspect environment',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'What an environment resumes from: its head snapshot, how far its log had got, and its fork tree. Every start is a cold boot from the head snapshot: files survive, running processes do not.',
      inputSchema: {
        type: 'object',
        properties: { environment: { type: 'string' } },
        required: ['environment'],
        additionalProperties: false,
      },
      async handler({ environment }) {
        const body = await client.lineage(environment);
        const head = body.head ?? null;
        const lines = [`environment ${environment}`];
        if (!head) {
          lines.push('never sealed — the next command cold-boots it');
        } else {
          // A snapshot is a disk image and there is no other kind: memory
          // snapshotting was removed outright and every start is a cold boot
          // (fleet ADR-0104). The `disk+mem` branch this replaced told agents
          // a resumed environment came back mid-process, which shaped how they
          // planned long runs.
          const kind = head.kind ?? 'unknown';
          lines.push(`head snapshot is ${kind} — the next command boots from it`);
          if (head.log_seq !== undefined) lines.push(`at log seq ${head.log_seq}`);
        }
        const forks = body.forks ?? [];
        const ancestors = body.ancestors ?? [];
        lines.push(`${forks.length} fork(s), ${ancestors.length} ancestor(s)`);
        return lines.join('\n');
      },
    },

    {
      name: 'run_command',
      title: 'Run a command',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Run one command in an environment and get its exit code and output. Not a shell: pass argv as a list, and ask for a shell explicitly with ["/bin/sh","-lc","…"] if you want one. A paused environment resumes to serve this.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
          cwd: { type: 'string' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          timeout_ms: {
            type: 'integer',
            description:
              'Give up after this long. PASS IT. Clamped by the entitlement server-side, and without it the environment is allowed ten minutes — so a wedged environment costs you ten before you learn anything. Seconds to a couple of minutes suits most commands; raise it for builds.',
          },
        },
        required: ['environment', 'argv'],
        additionalProperties: false,
      },
      async handler({ environment, argv, cwd, env, timeout_ms }) {
        const result = await client.exec(environment, { argv, cwd, env, timeoutMs: timeout_ms });
        return renderExec(result);
      },
    },

    {
      name: 'checkpoint_environment',
      title: 'Fork environment',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Fork an environment from its last sealed snapshot into a new one. The original is untouched. This is how you try several approaches from one prepared state — the fork costs a delta, not a rebuild.',
      inputSchema: {
        type: 'object',
        properties: {
          environment: { type: 'string' },
          name: { type: 'string', description: 'Name for the fork.' },
        },
        required: ['environment'],
        additionalProperties: false,
      },
      async handler({ environment, name }) {
        const body = await client.fork(environment, name);
        const id = body.workspace?.id ?? body.id ?? '(unknown)';
        return `forked ${environment} → ${id}${name ? ` (${name})` : ''}`;
      },
    },

    {
      name: 'delete_environment',
      title: 'Archive environment',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Archive an environment, freeing the plan slot it holds. Nothing is deleted: its snapshots and history survive, it simply stops counting as live and can no longer be used.',
      inputSchema: {
        type: 'object',
        properties: { environment: { type: 'string' } },
        required: ['environment'],
        additionalProperties: false,
      },
      async handler({ environment }) {
        await client.archive(environment);
        return `environment ${environment} archived; its history is intact and its plan slot is free`;
      },
    },
  ];
}

/**
 * Clone into /work. `set -e` so a failed clone is a failed exec rather than a
 * zero exit on an empty directory, which is the failure mode that makes an
 * agent spend ten minutes debugging a build in a directory with no source.
 */
function cloneScript(repo, ref) {
  const quoted = shellQuote(repo);
  const checkout = ref ? ` && git -C /work checkout ${shellQuote(ref)}` : '';
  return `set -e; mkdir -p /work; git clone ${quoted} /work${checkout}`;
}

/** Single-quote for /bin/sh, escaping embedded quotes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export const _internal = { tail, renderExec, cloneScript, shellQuote };
