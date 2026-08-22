/**
 * The two rules that are easy to get wrong quietly: what a refusal reads like,
 * and how much of a build log reaches the model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/errors.js';
import { _internal, buildTools } from '../src/tools.js';
import { resolveEndpoint } from '../src/client.js';

const { tail, renderExec, cloneScript, shellQuote } = _internal;

test('a refusal names the sentence, the numbers, then the code', () => {
  const text = render(403, 'entitlement_limit', {
    max_workspaces: 3,
    live_workspaces: 3,
    remedy: 'archive one',
  });
  assert.match(text, /^You are at your plan limit\./);
  assert.match(text, /max_workspaces=3 live_workspaces=3/);
  assert.ok(text.endsWith('[403 entitlement_limit]'));
});

test('an unknown code still produces something actionable', () => {
  const text = render(500, 'something_new', { detail: 'the node exploded' });
  assert.match(text, /something_new/);
  assert.match(text, /the node exploded/);
});

test('a refusal never forwards a field this package does not know', () => {
  // A future controld field must not reach a model just because it exists.
  const text = render(403, 'not_authorized', { secret_value: 'rpak1.leaked' });
  assert.doesNotMatch(text, /rpak1\.leaked/);
});

test('output is tailed, and the drop is named', () => {
  const long = `${'x'.repeat(5_000)}THE-FAILURE-IS-HERE`;
  const trimmed = tail(long);
  assert.ok(trimmed.text.endsWith('THE-FAILURE-IS-HERE'), 'the END of a log is the useful half');
  assert.equal(trimmed.text.length, 4_000);
  assert.ok(trimmed.dropped > 0);

  const rendered = renderExec({
    exit_code: 1,
    duration_ms: 5,
    stdout: long,
    stderr: '',
    truncated: false,
    timed_out: false,
    resumed: false,
  });
  assert.match(rendered, /bytes dropped/);
  assert.match(rendered, /THE-FAILURE-IS-HERE/);
});

test('a signal death is not reported as an exit code', () => {
  const rendered = renderExec({
    exit_code: null,
    signal: 'SIGKILL',
    duration_ms: 900,
    stdout: '',
    stderr: '',
    truncated: false,
    timed_out: false,
    resumed: false,
  });
  assert.match(rendered, /killed by SIGKILL/);
  assert.doesNotMatch(rendered, /exit /);
});

test('server-side truncation and timeouts are surfaced, not swallowed', () => {
  const rendered = renderExec({
    exit_code: 0,
    duration_ms: 1,
    stdout: 'out',
    stderr: '',
    truncated: true,
    timed_out: true,
    resumed: true,
  });
  assert.match(rendered, /TIMED OUT/);
  assert.match(rendered, /truncated server-side/);
  assert.match(rendered, /paused and resumed/);
});

test('a repo url cannot break out of the clone command', () => {
  const hostile = `https://x/y'; rm -rf /; echo '`;
  const script = cloneScript(hostile);
  // The quote is closed and reopened by the escape, so the payload stays one
  // argument to git rather than becoming a second command.
  assert.ok(!/; rm -rf \/; echo/.test(script.replace(shellQuote(hostile), 'ARG')));
  assert.match(script, /^set -e/);
});

test('endpoint resolution refuses plaintext to anywhere but loopback', () => {
  assert.equal(resolveEndpoint('m1.reachpad.dev'), 'https://m1.reachpad.dev');
  assert.equal(resolveEndpoint('https://m1.reachpad.dev/'), 'https://m1.reachpad.dev');
  assert.equal(resolveEndpoint('http://127.0.0.1:7401'), 'http://127.0.0.1:7401');
  assert.throws(() => resolveEndpoint('http://example.com'), /refusing plaintext/);
  assert.throws(() => resolveEndpoint(''), /no endpoint/);
});

test('a sealed head is READ, not reported as never sealed', async () => {
  // The regression this pins: the handler read `body.head` and the endpoint
  // answers `head_snapshot`, so every environment came back "never sealed" —
  // including ones with forks, which cannot exist without a seal. The stub
  // carried the wrong key too, so the suite agreed with the bug. Assert the
  // wire key here, against a body shaped like the real one.
  const wire = {
    head_snapshot: { id: 'snap-1063', log_seq: 10, purpose: 'checkpoint' },
    snapshots: [],
    forks: [],
    ancestors: [],
    spawned: [],
  };
  const tools = buildTools({ lineage: async () => wire });
  const text = await tools.find((t) => t.name === 'get_environment').handler({ environment: 'ws-1' });

  assert.doesNotMatch(text, /never sealed/);
  assert.match(text, /boots from snap-1063/);
  assert.match(text, /at log seq 10/);
  assert.match(text, /running processes do not/);
});

test('inspecting an environment never promises a mid-process resume', async () => {
  // Memory snapshotting was removed from the fleet outright (ADR-0104) and
  // every start is a cold boot. This tool's description and its rendering both
  // used to tell an agent that a `disk+mem` head came back mid-process, which
  // is the one fact that changes how an agent plans a long run: it decides
  // whether pausing costs it the work in flight.
  const tools = buildTools({
    lineage: async () => ({
      head_snapshot: { id: 'snap-42', log_seq: 42 },
      forks: [],
      ancestors: [],
    }),
  });
  const inspect = tools.find((t) => t.name === 'get_environment');

  assert.doesNotMatch(inspect.description, /memory|mid-process/i);
  assert.match(inspect.description, /cold boot/i);

  const text = await inspect.handler({ environment: 'ws-1' });
  assert.doesNotMatch(text, /mid-process|disk\+mem/i);
  assert.match(text, /boots from snap-42/);
});

test('an environment with no head says so, and says it cold-boots', async () => {
  const tools = buildTools({
    lineage: async () => ({ head_snapshot: null, forks: [], ancestors: [] }),
  });
  const inspect = tools.find((t) => t.name === 'get_environment');
  const text = await inspect.handler({ environment: 'ws-2' });
  assert.match(text, /never sealed/);
  assert.match(text, /cold-boots/);
});
