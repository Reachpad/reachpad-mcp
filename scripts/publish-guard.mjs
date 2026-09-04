#!/usr/bin/env node
/**
 * Refuse `npm publish` anywhere but the release workflow.
 *
 * A release here is TWO publishes: npm, then the MCP registry. Running
 * `npm publish` by hand does only the first, and it does it without running
 * the tests — so the registry never sees the version, and the number is spent
 * and cannot be reused by the workflow that would have caught the problem.
 *
 * This is not hypothetical. 0.3.1 went out this way on 2026-08-24 (`npm view
 * @reachpad/mcp@0.3.1 _npmUser.name` says a person; every other release says
 * `GitHub Actions`). It carried a 153-character description. The MCP registry
 * caps that field at 100 and answers 422 — but nothing tried to publish 0.3.1
 * to the registry, so the cap went unnoticed for three days until v0.4.0 hit
 * it, after npm had already taken 0.4.0. The registry listing sat on 0.3.0 the
 * whole time.
 *
 * This used to gate on `process.env.CI` alone, which is three different
 * bypasses wearing one coat: `CI=1` passes, `CI=false` passes (the STRING
 * "false" is truthy), and anyone can set either. So the check now asserts the
 * identity it actually means — GitHub Actions, in THIS repository, on a v*
 * TAG — rather than the presence of a variable any shell can export. `CI` is
 * still read, and read properly, but only to say something useful when a
 * different runner is the reason for the refusal.
 *
 * What this CANNOT defend, and no `prepublishOnly` script can: `npm publish
 * --ignore-scripts` never runs this file at all. An in-package guard is a
 * guard against mistakes, not against intent. The durable control is
 * npm-side — Trusted-Publisher-only publishing on the package, which makes a
 * publish from anywhere but this workflow impossible rather than merely
 * discouraged. That is a setting on npmjs.com, not a line of code in here.
 *
 * If you genuinely need to publish outside the workflow, the escape hatch is
 * explicit and greppable: `ALLOW_MANUAL_PUBLISH=1 npm publish`. Reach for the
 * tag instead — `git tag -a vX.Y.Z <sha> && git push origin vX.Y.Z` — which
 * runs the tests and both publishes.
 */

import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Reachpad/reachpad-mcp';

/** Truthy `CI` as the ecosystem means it: "false" and "0" are not CI. */
export function isCi(env) {
  const value = (env.CI ?? '').trim().toLowerCase();
  return value !== '' && value !== 'false' && value !== '0';
}

/**
 * Is this the release workflow, or something wearing its environment
 * variables? Every clause is one the runner sets and a caller cannot forge
 * from a laptop without lying about all three at once — which is what
 * ALLOW_MANUAL_PUBLISH is for, said out loud.
 *
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function releaseWorkflowIdentity(env) {
  if (env.GITHUB_ACTIONS !== 'true') {
    return { ok: false, why: isCi(env) ? `CI is set but this is not GitHub Actions` : 'not running in CI' };
  }
  if (env.GITHUB_REPOSITORY !== REPOSITORY) {
    return { ok: false, why: `GitHub Actions in ${env.GITHUB_REPOSITORY || '(no repository)'}, not ${REPOSITORY}` };
  }
  // A TAG. `GITHUB_REF_NAME` is the branch name on a branch build, so a
  // branch called `v0.4.2` reads identically there; the full ref does not.
  if (env.GITHUB_REF_TYPE !== 'tag' || !/^refs\/tags\/v/.test(env.GITHUB_REF ?? '')) {
    return { ok: false, why: `not a v* tag build (ref ${env.GITHUB_REF || '(none)'})` };
  }
  return { ok: true };
}

export function guard(env) {
  if (env.ALLOW_MANUAL_PUBLISH === '1') {
    return {
      exitCode: 0,
      message:
        'publish-guard: ALLOW_MANUAL_PUBLISH=1 — publishing outside CI on purpose.\n' +
        'publish-guard: the MCP registry half will NOT run. Publish it yourself or expect the listing to lag.\n',
    };
  }

  const identity = releaseWorkflowIdentity(env);
  if (identity.ok) return { exitCode: 0, message: '' };

  return {
    exitCode: 1,
    message:
      '\npublish-guard: REFUSING to publish — this is not the release workflow.\n\n' +
      `  ${identity.why}\n\n` +
      '  A release is two publishes — npm and the MCP registry. Doing this by\n' +
      '  hand does only the first, skips the tests, and burns the version\n' +
      '  number for the workflow that would have caught what is wrong with it.\n\n' +
      '  Release by pushing a tag instead:\n\n' +
      '      git tag -a v<version> <sha> -m "<what changed>"\n' +
      '      git push origin v<version>\n\n' +
      '  That runs the tests, publishes to npm, and publishes to the registry.\n\n' +
      '  If you really mean to do it by hand: ALLOW_MANUAL_PUBLISH=1 npm publish\n\n',
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { exitCode, message } = guard(process.env);
  if (message) process.stderr.write(message);
  // Let stdio drain before Node exits. `process.exit()` can truncate the very
  // refusal that tells a CI log or a human why the publish was stopped.
  process.exitCode = exitCode;
}
