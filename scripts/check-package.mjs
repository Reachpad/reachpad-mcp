#!/usr/bin/env node
/** Verify the exact npm artifact and smoke-test the installed entry point. */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = 'git+https://github.com/Reachpad/reachpad-mcp.git';

export const EXPECTED_PACKAGE_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'package.json',
  'src/client.js',
  'src/errors.js',
  'src/http.js',
  'src/jsonrpc.js',
  'src/server.d.ts',
  'src/server.js',
  'src/tools.js',
  'src/validate.js',
].sort());

export function validatePackReport(report, pkg) {
  if (!Array.isArray(report) || report.length !== 1 || !report[0] || typeof report[0] !== 'object') {
    throw new Error('npm pack returned an unexpected report shape');
  }

  const entry = report[0];
  if (!Array.isArray(entry.files) || !entry.files.every((file) => typeof file?.path === 'string')) {
    throw new Error('npm pack returned an invalid file list');
  }
  const files = entry.files.map((file) => file.path).sort();
  const exact =
    files.length === EXPECTED_PACKAGE_FILES.length &&
    files.every((file, index) => file === EXPECTED_PACKAGE_FILES[index]);
  if (!exact) {
    // Paths are untrusted too: a stray filename can itself contain a copied
    // credential. Keep CI diagnostics useful without reflecting it.
    throw new Error(
      `npm tarball contents differ from the allowlist (expected ${EXPECTED_PACKAGE_FILES.length} files, got ${files.length})`,
    );
  }
  if (entry.name !== pkg.name || entry.version !== pkg.version) {
    throw new Error('npm pack metadata does not match package.json');
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
    throw new Error('npm pack returned an invalid tarball size');
  }
  if (pkg.repository?.type !== 'git' || pkg.repository?.url !== REPOSITORY) {
    throw new Error('package.json repository must exactly name the provenance repository');
  }

  return { files, size: entry.size };
}

export function checkPackage(artifactPath) {
  // A space in the directory is deliberate. Both the package's executable
  // check and consumers' npm invocations have historically been easy places
  // to confuse filesystem paths with URL or shell syntax.
  const temporary = mkdtempSync(join(tmpdir(), 'reachpad packed artifact '));
  try {
    const packed = run('npm', [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temporary,
    ], { cwd: ROOT, operation: 'npm pack' });

    let report;
    try {
      report = JSON.parse(packed.stdout);
    } catch {
      throw new Error('npm pack returned invalid JSON');
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const result = validatePackReport(report, pkg);

    const artifacts = readdirSync(temporary, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'));
    if (artifacts.length !== 1) {
      throw new Error(`npm pack created ${artifacts.length} tarballs; expected exactly one`);
    }

    // Install from the bytes npm actually produced, with every lifecycle hook
    // disabled. Importing source from the checkout would not catch a missing
    // runtime module, a broken `bin` mapping, or a package-only path bug.
    const consumer = join(temporary, 'consumer with spaces');
    mkdirSync(consumer);
    const tarball = join(temporary, artifacts[0].name);
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      consumer,
      tarball,
    ], { operation: 'installing the packed artifact' });

    const executable = join(consumer, 'node_modules', '.bin', 'reachpad-mcp');
    const smoke = run(executable, [], {
      operation: 'running the packed executable',
      input: '{"jsonrpc":"2.0","id":"package-smoke","method":"ping"}\n',
      env: { PATH: process.env.PATH ?? '' },
    });
    let response;
    try {
      response = JSON.parse(smoke.stdout);
    } catch {
      throw new Error('packed executable returned invalid JSON');
    }
    if (
      response?.jsonrpc !== '2.0' ||
      response?.id !== 'package-smoke' ||
      !response.result ||
      typeof response.result !== 'object' ||
      Array.isArray(response.result) ||
      Object.keys(response.result).length !== 0
    ) {
      throw new Error('packed executable returned an unexpected ping response');
    }

    // Release verification may retain one explicitly named copy. Everything
    // else remains under the temporary directory and is removed in `finally`,
    // so ordinary CI and local tests never leave package artifacts behind.
    if (artifactPath) copyFileSync(tarball, resolve(artifactPath));

    process.stdout.write(
      `npm tarball is ${result.size} bytes, ${result.files.length} allowlisted files; installed executable passed\n`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function run(command, args, { operation, ...options }) {
  const child = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (child.error || child.status !== 0) {
    throw new Error(
      `${operation} failed${child.status === null ? '' : ` with exit ${child.status}`}`,
      { cause: child.error },
    );
  }
  return child;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  checkPackage(process.argv[2] ?? process.env.REACHPAD_PACKAGE_ARTIFACT);
}
