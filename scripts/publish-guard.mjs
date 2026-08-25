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
 * `CI` is set by GitHub Actions and by every other runner worth naming. That
 * is a deliberate choice of gate: it costs nothing, needs no credential to
 * check, and the failure mode if it is ever wrong is a refused publish rather
 * than a bad one.
 *
 * If you genuinely need to publish outside the workflow, the escape hatch is
 * explicit and greppable: `ALLOW_MANUAL_PUBLISH=1 npm publish`. Reach for the
 * tag instead — `git tag -a vX.Y.Z <sha> && git push origin vX.Y.Z` — which
 * runs the tests and both publishes.
 */

if (process.env.ALLOW_MANUAL_PUBLISH === '1') {
  process.stderr.write(
    'publish-guard: ALLOW_MANUAL_PUBLISH=1 — publishing outside CI on purpose.\n' +
      'publish-guard: the MCP registry half will NOT run. Publish it yourself or expect the listing to lag.\n',
  );
  process.exit(0);
}

if (!process.env.CI) {
  process.stderr.write(
    '\npublish-guard: REFUSING to publish from outside CI.\n\n' +
      '  A release is two publishes — npm and the MCP registry. Doing this by\n' +
      '  hand does only the first, skips the tests, and burns the version\n' +
      '  number for the workflow that would have caught what is wrong with it.\n\n' +
      '  Release by pushing a tag instead:\n\n' +
      '      git tag -a v<version> <sha> -m "<what changed>"\n' +
      '      git push origin v<version>\n\n' +
      '  That runs the tests, publishes to npm, and publishes to the registry.\n\n' +
      '  If you really mean to do it by hand: ALLOW_MANUAL_PUBLISH=1 npm publish\n\n',
  );
  process.exit(1);
}
