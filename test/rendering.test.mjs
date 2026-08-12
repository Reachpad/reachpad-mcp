/**
 * The two rules that are easy to get wrong quietly: what a refusal reads like,
 * and how much of a build log reaches the model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/errors.js';
import { _internal } from '../src/tools.js';
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
