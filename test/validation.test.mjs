/**
 * The schemas mean something now.
 *
 * `inputSchema` was advertising: `tools/list` promised types, `required` and
 * `additionalProperties: false`, and `tools/call` handed `params.arguments`
 * straight to the handler. These pin the enforcement, and the shell sink that
 * made it matter most.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArguments } from '../src/validate.js';
import { _internal, buildTools } from '../src/tools.js';

const { probePort } = _internal;

/** The real schema, so these tests fail when a tool's schema changes shape. */
function schemaFor(name) {
  const tool = buildTools({}).find((one) => one.name === name);
  assert.ok(tool, `no such tool: ${name}`);
  return tool.inputSchema;
}

test('a required argument that is missing is a problem, not a default', () => {
  const problems = validateArguments({ argv: ['true'] }, schemaFor('run_command'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /`workspace` is required/);
});

test('a string where an integer is declared is refused', () => {
  // The case that reached a shell: `port` is interpolated into a command.
  const problems = validateArguments(
    { workspace: 'ws-1', port: '8080; rm -rf /' },
    schemaFor('expose_port'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /expected integer, got string/);
});

test('minimum and maximum are enforced, not decorative', () => {
  const schema = schemaFor('expose_port');
  assert.match(
    validateArguments({ workspace: 'ws-1', port: 0 }, schema)[0],
    /must be >= 1/,
  );
  assert.match(
    validateArguments({ workspace: 'ws-1', port: 70_000 }, schema)[0],
    /must be <= 65535/,
  );
  assert.deepEqual(validateArguments({ workspace: 'ws-1', port: 8080 }, schema), []);
});

test('run_command timeout is bounded by the server cap', () => {
  const schema = schemaFor('run_command');
  assert.match(
    validateArguments({ workspace: 'ws-1', argv: ['true'], timeout_ms: 0 }, schema)[0],
    /must be >= 1/,
  );
  assert.deepEqual(
    validateArguments({ workspace: 'ws-1', argv: ['true'], timeout_ms: 1 }, schema),
    [],
  );
  assert.deepEqual(
    validateArguments({ workspace: 'ws-1', argv: ['true'], timeout_ms: 600_000 }, schema),
    [],
  );
  assert.match(
    validateArguments({ workspace: 'ws-1', argv: ['true'], timeout_ms: 600_001 }, schema)[0],
    /must be <= 600000/,
  );
});

test('additionalProperties: false refuses a property the tool never declared', () => {
  const problems = validateArguments(
    { workspace: 'ws-1', kind: 'memory' },
    schemaFor('get_workspace'),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /property not declared by the schema/);
});

test('array items and minItems are checked all the way down', () => {
  const schema = schemaFor('run_command');
  assert.match(
    validateArguments({ workspace: 'ws-1', argv: [] }, schema)[0],
    /at least 1 item/,
  );
  assert.match(
    validateArguments({ workspace: 'ws-1', argv: ['sh', 7] }, schema)[0],
    /argv\[1\]: expected string/,
  );
});

test('a schema-valued additionalProperties checks the values', () => {
  // `run_command`'s `env` is {type: object, additionalProperties: {type: string}}.
  const schema = schemaFor('run_command');
  assert.deepEqual(
    validateArguments({ workspace: 'ws-1', argv: ['true'], env: { A: 'b' } }, schema),
    [],
  );
  assert.match(
    validateArguments({ workspace: 'ws-1', argv: ['true'], env: { A: 3 } }, schema)[0],
    /env\.\*: expected string/,
  );
});

test('an omitted optional argument is an absence, not a bad value', () => {
  assert.deepEqual(
    validateArguments({ workspace: 'ws-1', argv: ['true'], cwd: undefined }, schemaFor('run_command')),
    [],
  );
});

test('a keyword this validator cannot check is a failure, never a silent pass', () => {
  // The failure mode worth spending a test on: a schema grows `pattern`, this
  // file does not implement it, and the check quietly stops being one.
  const problems = validateArguments('anything', { type: 'string', pattern: '^v' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unsupported keyword `pattern`/);
});

test('every shipped tool schema is one this validator actually understands', () => {
  // The guard above only helps if something notices. This is the something.
  for (const tool of buildTools({})) {
    assert.deepEqual(
      validateArguments({}, tool.inputSchema).filter((one) => /unsupported keyword/.test(one)),
      [],
      `${tool.name} declares a keyword src/validate.js does not implement`,
    );
  }
});

test('the port probe quotes its port instead of pasting it into a shell', async () => {
  // Belt as well as braces: validation refuses a non-integer port at the door,
  // and the sink behind it no longer depends on that having happened. Run by a
  // REAL /bin/sh, because the only convincing evidence that a shell does not
  // execute something is a shell not executing it.
  const sentinel = join(await mkdtemp(join(tmpdir(), 'reachpad-probe-')), 'pwned');
  let sent;
  const client = {
    async exec(workspace, options) {
      sent = options.argv;
      return { exit_code: 0 };
    },
  };
  await probePort(client, 'ws-1', `8080'; touch ${sentinel}; '`);

  assert.equal(sent[0], '/bin/sh');
  const script = sent[2];
  assert.match(script, /int\(sys\.argv\[1\]\)/, 'the port reaches python as an argument');
  assert.match(script, /grep -q ":\$port "/, 'and reaches grep as a variable');

  const ran = spawnSync('/bin/sh', ['-lc', script], { encoding: 'utf8' });
  assert.notEqual(ran.status, 0, 'a port that is not a number cannot be dialled');
  assert.equal(existsSync(sentinel), false, 'the injected command must never run');
});
