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
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXPECTED_PACKAGE_FILES,
  validatePackReport,
} from '../scripts/check-package.mjs';
import {
  assertMatchingIntegrity,
  publishedVersions,
  sha512Integrity,
} from '../scripts/publish-package.mjs';
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

test('the publish guard still runs when its filesystem path contains spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reachpad publish guard '));
  try {
    const target = join(directory, 'publish guard.mjs');
    const source = await readFile(new URL('../scripts/publish-guard.mjs', import.meta.url));
    await writeFile(target, source);
    const child = spawnSync(process.execPath, [target], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    assert.equal(child.status, 1);
    assert.match(
      child.stderr,
      /REFUSING to publish/,
      `guard subprocess: ${JSON.stringify({
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        stdout: child.stdout,
        stderr: child.stderr,
      })}`,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
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

test('every workflow action is pinned to an immutable commit', async () => {
  const expected = {
    'ci.yml': [
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    ],
    'publish.yml': [
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    ],
  };
  for (const name of Object.keys(expected)) {
    const source = await workflow(name);
    const actions = [...source.matchAll(/^\s*- uses: ([^@\s]+)@([^\s]+)/gm)];
    assert.ok(actions.length > 0, `${name} must contain an action to inspect`);
    for (const [, action, ref] of actions) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${name}: ${action} is not commit-pinned`);
    }
    assert.deepEqual(
      actions.map(([, action, ref]) => `${action}@${ref}`),
      expected[name],
      `${name} must use only the reviewed action commits`,
    );
  }
});

test('CI is read-only and covers all supported Node release lines', async () => {
  const ci = await workflow('ci.yml');
  assert.match(ci, /^permissions:\n  contents: read$/m);
  assert.match(ci, /node: \[22, 24, 26\]/);
  assert.match(ci, /timeout-minutes: 10/);
  assert.match(ci, /npm run ci/);
});

test('release retries serialize by tag and every release job has a deadline', async () => {
  const publish = await workflow('publish.yml');
  assert.match(publish, /^permissions: \{\}$/m, 'future jobs must start with no token permissions');
  assert.match(publish, /group: publish-\$\{\{ github\.ref \}\}/);
  assert.match(publish, /cancel-in-progress: false/);
  assert.equal((publish.match(/timeout-minutes:/g) ?? []).length, 3);
});

test('release packaging and publication use one exact npm version', async () => {
  const publish = await workflow('publish.yml');
  const installs = publish.match(/npm install -g npm@11\.5\.1 --ignore-scripts/g) ?? [];
  assert.equal(installs.length, 2, 'verify and publish must use the same exact npm');
  assert.equal((publish.match(/actual_npm="\$\(npm --version\)"/g) ?? []).length, 2);
  assert.equal((publish.match(/expected 11\.5\.1/g) ?? []).length, 2);
  assert.doesNotMatch(publish, /npm@(\^|~|latest)/);
  assert.match(publish, /npm run ci/);
  assert.match(publish, /REACHPAD_PACKAGE_ARTIFACT=reachpad-mcp\.tgz/);
  assert.match(publish, /with: \{ name: npm-package \}/);
  assert.match(publish, /publish-package\.mjs reachpad-mcp\.tgz/);
  assert.doesNotMatch(publish, /^\s+npm publish\s*$/m);
});

test('an npm retry continues only when the published bytes match', () => {
  const local = sha512Integrity(Buffer.from('verified artifact'));
  assert.match(local, /^sha512-/);
  assert.doesNotThrow(() => assertMatchingIntegrity(local, local));
  assert.throws(
    () => assertMatchingIntegrity(local, sha512Integrity(Buffer.from('different artifact'))),
    /different bytes.*refusing/i,
  );
  assert.throws(() => assertMatchingIntegrity(local, undefined), /missing or invalid/);
  assert.deepEqual(publishedVersions('"0.4.2"'), ['0.4.2']);
  assert.deepEqual(publishedVersions('["0.4.1","0.4.2"]'), ['0.4.1', '0.4.2']);
  assert.throws(() => publishedVersions('{}'), /invalid published-version list/);
});

test('package metadata exposes only the supported entry point and no install hooks', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.files, ['src', 'README.md']);
  assert.deepEqual(pkg.exports, {
    '.': { types: './src/server.d.ts', default: './src/server.js' },
  });
  assert.deepEqual(pkg.bin, { 'reachpad-mcp': './src/server.js' });
  assert.equal(pkg.types, './src/server.d.ts');
  assert.equal(pkg.engines.node, '>=22');
  assert.equal(pkg.publishConfig.access, 'public');
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
  ]) {
    assert.equal(pkg[field], undefined, `${field} must remain absent from this zero-dependency package`);
  }
  for (const hook of [
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'prepare',
    'prepack',
    'postpack',
    'publish',
    'postpublish',
  ]) {
    assert.equal(pkg.scripts[hook], undefined, `${hook} would execute on a consumer's machine`);
  }
  assert.equal(pkg.scripts.prepublishOnly, 'node scripts/publish-guard.mjs');
});

test('the packed-file allowlist includes every runtime module and reflects no stray paths', () => {
  const pkg = {
    name: '@reachpad/mcp',
    version: '0.4.2',
    repository: {
      type: 'git',
      url: 'git+https://github.com/Reachpad/reachpad-mcp.git',
    },
  };
  const report = [{
    name: pkg.name,
    version: pkg.version,
    size: 123,
    files: EXPECTED_PACKAGE_FILES.map((path) => ({ path })),
  }];
  assert.deepEqual(validatePackReport(report, pkg).files, EXPECTED_PACKAGE_FILES);
  assert.ok(EXPECTED_PACKAGE_FILES.includes('src/jsonrpc.js'));

  const secret = 'npm-token-secret-sentinel';
  const stray = structuredClone(report);
  stray[0].files.push({ path: `src/${secret}` });
  assert.throws(
    () => validatePackReport(stray, pkg),
    (error) => {
      assert.match(error.message, /contents differ from the allowlist/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  const lookalike = structuredClone(pkg);
  lookalike.repository.url = 'git+https://github.com/evil/Reachpad/reachpad-mcp.git';
  assert.throws(
    () => validatePackReport(report, lookalike),
    /repository must exactly name the provenance repository/,
  );
});
