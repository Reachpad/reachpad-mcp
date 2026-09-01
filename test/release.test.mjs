/**
 * What it takes to publish this package, asserted rather than assumed.
 *
 * Both halves of a release run somewhere nobody watches: a workflow file and a
 * `prepublishOnly` script. Neither has a user to notice when it stops meaning
 * what it says, so the meanings are pinned here — this is the only place a
 * loosened publish gate shows up as a red test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guard, isCi, releaseWorkflowIdentity } from '../scripts/publish-guard.mjs';

/** The environment the release workflow actually presents. */
const RELEASE = {
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'Reachpad/reachpad-mcp',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REF: 'refs/tags/v0.4.1',
};

/**
 * The workflow with its comments stripped. Half of this file's assertions are
 * about what the workflow does NOT contain, and the comments explaining WHY it
 * no longer contains it say the same words — so a prose-only read makes every
 * one of them fail.
 */
async function workflow(name) {
  const text = await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

test('the release workflow itself passes the guard', () => {
  assert.deepEqual(releaseWorkflowIdentity(RELEASE), { ok: true });
  assert.equal(guard(RELEASE).exitCode, 0);
});

test('setting CI is not a way past the guard', () => {
  // All three were live bypasses of `if (!process.env.CI)`: `CI=1` passes,
  // `CI=false` passes because the STRING "false" is truthy, and either is one
  // word on a laptop.
  for (const CI of ['1', 'true', 'false', 'yes']) {
    const result = guard({ CI });
    assert.equal(result.exitCode, 1, `CI=${CI} must not authorize a publish`);
    assert.match(result.message, /REFUSING to publish/);
  }
});

test('CI is read the way the ecosystem writes it', () => {
  assert.equal(isCi({ CI: 'true' }), true);
  assert.equal(isCi({ CI: '1' }), true);
  assert.equal(isCi({ CI: 'false' }), false, '"false" is a string, and it means false');
  assert.equal(isCi({ CI: '0' }), false);
  assert.equal(isCi({ CI: '' }), false);
  assert.equal(isCi({}), false);
});

test('a branch that looks like a tag does not publish', () => {
  // Anyone with write access can push a branch called `v0.4.2`; nobody can
  // make `GITHUB_REF` say `refs/tags/` from one.
  const branch = { ...RELEASE, GITHUB_REF_TYPE: 'branch', GITHUB_REF: 'refs/heads/v0.4.2' };
  const result = releaseWorkflowIdentity(branch);
  assert.equal(result.ok, false);
  assert.match(result.why, /not a v\* tag build/);
});

test('another repository running this workflow does not publish as us', () => {
  const fork = { ...RELEASE, GITHUB_REPOSITORY: 'someone/reachpad-mcp' };
  const result = releaseWorkflowIdentity(fork);
  assert.equal(result.ok, false);
  assert.match(result.why, /not Reachpad\/reachpad-mcp/);
});

test('the manual escape hatch still exists, and still says what it costs', () => {
  const result = guard({ ALLOW_MANUAL_PUBLISH: '1' });
  assert.equal(result.exitCode, 0);
  assert.match(result.message, /MCP registry half will NOT run/);
});

test('the guard names the control it cannot itself provide', async () => {
  // `npm publish --ignore-scripts` never runs this file. A reader who does not
  // know that will believe the package is defended when it is not, so the
  // limit and the npm-side fix are written down where the guard is.
  const source = await readFile(new URL('../scripts/publish-guard.mjs', import.meta.url), 'utf8');
  assert.match(source, /--ignore-scripts/);
  assert.match(source, /Trusted-Publisher-only/);
});

test('mcp-publisher is pinned to a version and a digest, never to `latest`', async () => {
  const publish = await workflow('publish.yml');
  // `releases/latest/download/` resolves at run time, in a job that mints OIDC
  // tokens. A compromise of that third-party pipeline published this package.
  assert.doesNotMatch(publish, /releases\/latest\/download/);
  assert.match(publish, /MCP_PUBLISHER_VERSION: v\d+\.\d+\.\d+/);
  assert.match(publish, /MCP_PUBLISHER_SHA256: [0-9a-f]{64}/);
  // Checked on both sides of the artifact store, and checked BEFORE it runs.
  const checks = publish.match(/sha256sum -c -/g) ?? [];
  assert.equal(checks.length, 2, 'the digest is verified on download and again before use');
  assert.ok(
    publish.indexOf('sha256sum -c -') < publish.indexOf('./mcp-publisher login'),
    'the binary must be verified before it is executed',
  );
});

test('the OIDC privilege is scoped to the jobs that need it, and npm to one', async () => {
  const publish = await workflow('publish.yml');
  // `id-token: write` mints a token for ANY audience, so the job that runs a
  // third-party binary must not be the job npm trusts. The environment claim
  // is the only thing that differs between jobs in one workflow file, which
  // is why the npm publish names one and nothing else does.
  assert.equal((publish.match(/^\s+environment: npm-publish$/gm) ?? []).length, 1);
  const jobs = publish.slice(publish.indexOf('\njobs:'));
  const verify = jobs.slice(jobs.indexOf('  verify:'), jobs.indexOf('  npm:'));
  assert.doesNotMatch(verify, /id-token/, 'the job that fetches the binary mints nothing');
  assert.match(verify, /mcp-publisher_linux_amd64\.tar\.gz/);

  const registry = jobs.slice(jobs.indexOf('  registry:'));
  assert.doesNotMatch(registry, /environment:/, 'npm must refuse a token minted here');
  assert.match(registry, /\.\/mcp-publisher login github-oidc/);
});

test('a tag is the only way in, and the ref type is asserted', async () => {
  const publish = await workflow('publish.yml');
  // `workflow_dispatch` was a second publish path, and it runs from a branch.
  assert.doesNotMatch(publish, /workflow_dispatch/);
  assert.match(publish, /github\.ref_type\s*\}\}" != "tag"/);
  // The version check reads the full ref. `GITHUB_REF_NAME` is the BRANCH name
  // on a branch build, so `v0.4.2` reads identically there.
  assert.match(publish, /tag="\$\{GITHUB_REF#refs\/tags\/v\}"/);
  assert.doesNotMatch(publish, /GITHUB_REF_NAME/);
});
