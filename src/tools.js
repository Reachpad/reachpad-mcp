/**
 * The agent-facing surface (ADR-0066 §4). SMALLER than the API on purpose:
 * eleven tools, each a translation of routes that exist today. Nothing here
 * advertises a capability the fleet does not have — a tool that always fails
 * costs a model a turn and teaches it to distrust the rest.
 *
 * `expose_port` used to be listed here as deliberately absent, "needs the
 * `tcp` channel kind, ADR §6". That kind shipped (`ChannelKind::Tcp(port)`,
 * ADR-0103), `reachpad ports expose` has been live in the CLI since 0.4.0,
 * and the note outlived its reason — so an agent could build a working app
 * over this server and had no way at all to publish it. The three `*_port`
 * tools below close that, against the same
 * `/v1/workspaces/:id/port-shares` routes the CLI uses.
 *
 * Still deliberately absent, and named in the README so its absence is a
 * decision rather than an oversight: `start_agent` (needs a harness route,
 * ADR §5).
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
  if (result.resumed) lines.push('(the workspace was paused and resumed to run this)');
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
      name: 'get_credit_balance',
      title: 'Get compute-credit balance',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Show this account\'s remaining compute credits. One credit runs one standard workspace for one minute; paused workspaces use no compute credits.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const balance = await client.creditBalance();
        const millicredits = Number(balance.balance_millicredits ?? 0);
        return `${(millicredits / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} compute credits remaining\n1 credit = 1 active standard-workspace minute`;
      },
    },
    {
      name: 'create_workspace',
      title: 'Create workspace',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Create a persistent development workspace: a filesystem and processes that survive between calls. Optionally clone a git repository into it. Returns the workspace id used by every other tool.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Optional display name. Reachpad generates one when omitted.',
          },
          repo: {
            type: 'string',
            description: 'Optional git URL to clone into `$HOME/work` inside the workspace. Must be reachable without credentials unless the account has a mirror for it.',
          },
          ref: { type: 'string', description: 'Optional branch or tag to check out.' },
        },
        additionalProperties: false,
      },
      async handler({ name, repo, ref }) {
        const created = await client.createWorkspace(name);
        const lines = [`workspace ${created.id} created (name: ${created.name})`];
        if (repo) {
          const argv = ['/bin/sh', '-lc', cloneScript(repo, ref)];
          const result = await client.exec(created.id, { argv, timeoutMs: 300_000 });
          // The clone script's last line is the resolved path. Report THAT,
          // not the path this file hoped for: `cwd` on the next `run_command`
          // is the only thing the caller can do with this sentence.
          const where = result.stdout.trim().split('\n').pop() || '$HOME/work';
          lines.push(
            result.exit_code === 0
              ? `cloned ${repo}${ref ? ` at ${ref}` : ''} into ${where} — pass that as \`cwd\` to run_command`
              : `clone FAILED — the workspace exists and is usable, but the source is not there:\n${renderExec(result)}`,
          );
        }
        return lines.join('\n');
      },
    },

    {
      name: 'list_workspaces',
      title: 'List workspaces',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'List this account\'s workspaces, with how many forks each has.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const rows = await client.listWorkspaces();
        // The account leads, and it leads on the EMPTY answer especially: "no
        // workspaces" and "no workspaces for THIS account" are different
        // sentences, and only the second one lets someone spot a wrong login.
        const who = client.accountLabel ? `account: ${client.accountLabel}\n` : '';
        if (!rows.length) return `${who}No workspaces yet.`;
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
      name: 'get_workspace',
      title: 'Inspect workspace',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'What a workspace resumes from: its head snapshot, how far its log had got, and its fork tree. Every start is a cold boot from the head snapshot: files survive, running processes do not.',
      inputSchema: {
        type: 'object',
        properties: { workspace: { type: 'string' } },
        required: ['workspace'],
        additionalProperties: false,
      },
      async handler({ workspace }) {
        const body = await client.lineage(workspace);
        // `head_snapshot`, which is what GET /v1/workspaces/:id/lineage
        // actually answers with. Reading `head` meant this branch never fired:
        // EVERY workspace reported "never sealed", including ones with forks
        // hanging off a snapshot, which the fork route refuses to make without
        // one. The stub returned the wrong key too, so the tests agreed with
        // the bug — hence `sealedHeadIsRead` below, which pins the key name.
        const head = body.head_snapshot ?? null;
        const lines = [`workspace ${workspace}`];
        // State first, because it is the one line that changes what the
        // caller does next — and this is the only tool that reports it.
        // Never fatal: a fleet that does not serve the status route can still
        // answer the lineage question this tool exists for.
        try {
          const status = await client.workspaceStatus(workspace);
          lines.push(
            status.state === 'running'
              ? 'state: running — it holds a plan slot and spends a credit a minute'
              : `state: ${status.state}`,
          );
        } catch {
          /* not fatal — see above */
        }
        if (!head) {
          lines.push('never sealed — the next command cold-boots it');
        } else {
          // A snapshot is a disk image and there is no other kind: memory
          // snapshotting was removed outright and every start is a cold boot
          // (fleet ADR-0104), which also deleted the `kind` field this used to
          // branch on. Say what the agent needs to plan around instead.
          const at = head.log_seq === undefined ? '' : ` at log seq ${head.log_seq}`;
          lines.push(
            `boots from ${head.id}${at} — files survive, running processes do not`,
          );
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
        'Run one command in a workspace and get its exit code and output. Not a shell: pass argv as a list, and ask for a shell explicitly with ["/bin/sh","-lc","…"] if you want one. A paused workspace resumes to serve this.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
          cwd: { type: 'string' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          timeout_ms: {
            type: 'integer',
            description:
              'Give up after this long. PASS IT. Clamped by the entitlement server-side, and without it the workspace is allowed ten minutes — so a wedged workspace costs you ten before you learn anything. Seconds to a couple of minutes suits most commands; raise it for builds.',
          },
        },
        required: ['workspace', 'argv'],
        additionalProperties: false,
      },
      async handler({ workspace, argv, cwd, env, timeout_ms }) {
        const result = await client.exec(workspace, { argv, cwd, env, timeoutMs: timeout_ms });
        return renderExec(result);
      },
    },

    {
      name: 'checkpoint_workspace',
      title: 'Fork workspace',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        'Fork a workspace from its last sealed snapshot into a new one. The original is untouched. This is how you try several approaches from one prepared state — the fork costs a delta, not a rebuild.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          name: { type: 'string', description: 'Name for the fork.' },
        },
        required: ['workspace'],
        additionalProperties: false,
      },
      async handler({ workspace, name }) {
        const body = await client.fork(workspace, name);
        const id = body.workspace?.id ?? body.id ?? '(unknown)';
        return `forked ${workspace} → ${id}${name ? ` (${name})` : ''}`;
      },
    },

    {
      name: 'expose_port',
      title: 'Expose a port to the web',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Open a port inside a workspace and get back a link that reaches it. This is how something you built becomes something a person can open. Idempotent per port: re-running it returns the link the port already has.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          port: {
            type: 'integer',
            minimum: 1,
            maximum: 65535,
            description: 'The port your app is listening on INSIDE the workspace.',
          },
          check: {
            type: 'boolean',
            description:
              'Dial the port inside the workspace afterwards and say whether anything answered. Default true. It costs one short command, and it RESUMES the workspace if it was paused — pass false if you are opening a port ahead of starting the server.',
          },
        },
        required: ['workspace', 'port'],
        additionalProperties: false,
      },
      async handler({ workspace, port, check = true }) {
        const share = await client.createPortShare(workspace, port);
        const lines = [
          share.url
            ? `port ${share.port} in ${workspace} is open at ${share.url}`
            : `port ${share.port} in ${workspace} is open (token ${share.token}) — this deployment reports no preview origin, so there is no link to hand out`,
        ];
        if (check) {
          const state = await probePort(client, workspace, share.port);
          if (state === 'silent') {
            lines.push(
              `NOTHING IS LISTENING on ${share.port} right now. The link resolves, and a visitor gets an error page rather than your app. Start the server, then this same link serves it — no new link is needed.`,
            );
          } else if (state === 'unknown') {
            lines.push(`(could not check whether anything is listening on ${share.port})`);
          }
        }
        lines.push(
          'Who can open it: anyone who has the link AND is signed in to Reachpad. It is not a private URL and not a secure one — treat it like a preview deployment. It carries no port, no workspace id and no account name.',
        );
        lines.push(
          'What breaks it: a running process does NOT survive a pause. After a pause the workspace cold-boots, files intact and nothing running, and the link answers with an error until you start the app again on the same port. A visitor’s request wakes a paused workspace but does not restart anything in it.',
        );
        return lines.join('\n');
      },
    },

    {
      name: 'list_ports',
      title: 'List exposed ports',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'The ports this workspace has open to the web, oldest first, with their links. Revoked ports are not listed: a closed link never comes back.',
      inputSchema: {
        type: 'object',
        properties: { workspace: { type: 'string' } },
        required: ['workspace'],
        additionalProperties: false,
      },
      async handler({ workspace }) {
        const shares = await client.listPortShares(workspace);
        if (!shares.length) return `no ports are open in ${workspace}`;
        return shares
          .map((s) => `${s.port}  ${s.url ?? `(token ${s.token})`}`)
          .join('\n');
      },
    },

    {
      name: 'revoke_port',
      title: 'Close an exposed port',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        'Close one port to the web. The link stops working at the visitor’s next request. NOT reversible in the way callers expect: re-opening the same port later mints a DIFFERENT link, so revoke only when the people holding the current one should lose it.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
        },
        required: ['workspace', 'port'],
        additionalProperties: false,
      },
      async handler({ workspace, port }) {
        await client.revokePortShare(workspace, port);
        return `port ${port} is closed in ${workspace}; the link that reached it stops working at the next request, and re-opening this port mints a new one`;
      },
    },

    {
      name: 'pause_workspace',
      title: 'Pause workspace',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Save the workspace's disk and stop the meter. Files survive; RUNNING PROCESSES DO NOT \u2014 a paused workspace cold-boots, so anything you started with run_command has to be started again. The next run_command resumes it automatically. Pause when you are done: a running workspace spends a credit a minute whether or not anything is happening in it, and it cannot be archived while it runs.",
      inputSchema: {
        type: 'object',
        properties: { workspace: { type: 'string' } },
        required: ['workspace'],
        additionalProperties: false,
      },
      async handler({ workspace }) {
        const status = await client.workspaceStatus(workspace);
        if (status.state === 'paused') return `workspace ${workspace} is already paused`;
        if (status.state === 'sealing') return `workspace ${workspace} is already saving`;
        if (status.state === 'archived') {
          return `workspace ${workspace} is archived \u2014 there is nothing running to pause`;
        }
        if (status.state === 'never_started') {
          return `workspace ${workspace} has never run, so there is nothing to save`;
        }
        const fencingToken = status.lease?.fencingToken;
        if (!fencingToken) {
          // The token is reported only to a caller the server also authorizes
          // to WRITE, so its absence is an authority answer, not a race.
          return `workspace ${workspace} reports no lease this credential may release \u2014 it needs write access`;
        }
        await client.release(workspace, fencingToken);
        return `workspace ${workspace} is saving its disk and stopping; the next run_command resumes it, with nothing running inside it`;
      },
    },

    {
      name: 'delete_workspace',
      title: 'Archive workspace',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        'Archive a workspace, freeing the plan slot it holds. Nothing is deleted: its snapshots and history survive, it simply stops counting as live and can no longer be used. A RUNNING workspace cannot be archived \u2014 pause_workspace first, or this is refused with `lease_held`.',
      inputSchema: {
        type: 'object',
        properties: { workspace: { type: 'string' } },
        required: ['workspace'],
        additionalProperties: false,
      },
      async handler({ workspace }) {
        await client.archive(workspace);
        return `workspace ${workspace} archived; its history is intact and its plan slot is free`;
      },
    },
  ];
}

/**
 * Is anything actually listening on `port` inside the workspace?
 *
 * The dial is the one hub itself makes — a TCP connect to `127.0.0.1:<port>`
 * in the guest (`ChannelKind::Tcp`) — so a pass here means a visitor's
 * request reaches something, not merely that a process exists. `ss` is the
 * fallback for an image without python3; a listener bound to one interface
 * shows up in both.
 *
 * Best-effort by construction. Every failure that is not a clean "nothing
 * answered" reports `unknown`: a probe that cannot run is not evidence that
 * the port is dead, and saying so would be worse than saying nothing.
 *
 * `port` is `shellQuote`d into ONE shell variable and read from there, the way
 * `cloneScript` has always treated its inputs. It used to be interpolated raw
 * into a `python3 -c` argument and a grep pattern, and the whole string was
 * then shipped as `['/bin/sh','-lc',script]` — so the only thing standing
 * between a tool argument and a shell was an `inputSchema` nothing enforced.
 * Reading it back as `"$port"` also keeps it out of the python source, where
 * a quote would have closed the literal the interpolation sat inside.
 *
 * @returns {Promise<'listening'|'silent'|'unknown'>}
 */
async function probePort(client, workspace, port) {
  const script =
    `port=${shellQuote(port)}; ` +
    `if command -v python3 >/dev/null 2>&1; then ` +
    `python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(2); ` +
    `sys.exit(0 if s.connect_ex(("127.0.0.1",int(sys.argv[1])))==0 else 1)' "$port"; ` +
    `else ss -ltn 2>/dev/null | grep -q ":$port "; fi`;
  try {
    const result = await client.exec(workspace, {
      argv: ['/bin/sh', '-lc', script],
      timeoutMs: 15_000,
    });
    if (result.exit_code === 0) return 'listening';
    if (result.exit_code === 1) return 'silent';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Clone into `$HOME/work`, and NEVER into `/work`.
 *
 * This used to say `/work`, and it could not have worked once: the guest
 * rootfs is mounted `ro` (`/dev/root / ext4 ro`), so `mkdir -p /work` failed
 * with "Read-only file system" on every workspace this server has ever
 * created — the first move an agent makes, broken 100% of the time. The one
 * writable surface that survives a pause is the workspace disk, mounted at
 * `/mnt` and at `$HOME`; `$HOME` is where a person's files already are.
 *
 * `$HOME` rather than a literal `/root`: the guest's home is `workspaced`'s
 * decision, not this client's, and it moves.
 *
 * `set -e` so a failed clone is a failed exec rather than a zero exit on an
 * empty directory, which is the failure mode that makes an agent spend ten
 * minutes debugging a build in a directory with no source. The last line
 * prints the resolved path so the caller can report where the source
 * actually landed rather than where it hoped to put it.
 */
function cloneScript(repo, ref) {
  const quoted = shellQuote(repo);
  const checkout = ref ? ` && git -C "$HOME/work" checkout ${shellQuote(ref)}` : '';
  return `set -e; mkdir -p "$HOME/work"; git clone ${quoted} "$HOME/work"${checkout}; printf '%s\\n' "$HOME/work"`;
}

/** Single-quote for /bin/sh, escaping embedded quotes. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export const _internal = { tail, renderExec, cloneScript, shellQuote, probePort };
