#!/usr/bin/env node
/** Publish only the tarball verified by the unprivileged release job. */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function publishedVersions(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('npm returned invalid JSON while checking published versions');
  }
  const versions = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(versions) || !versions.every((version) => typeof version === 'string')) {
    throw new Error('npm returned an invalid published-version list');
  }
  return versions;
}

export function assertMatchingIntegrity(local, remote) {
  if (typeof remote !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(remote)) {
    throw new Error('npm returned a missing or invalid dist.integrity');
  }
  if (local !== remote) {
    throw new Error(
      'the existing npm version has different bytes from the verified tarball; refusing to continue the release',
    );
  }
}

export function publishPackage(artifactPath) {
  if (!artifactPath) throw new Error('usage: publish-package.mjs <verified.tgz>');
  const artifact = resolve(artifactPath);
  const localIntegrity = sha512Integrity(readFileSync(artifact));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new Error('package.json must contain a package name and version');
  }

  const versions = npm(['view', pkg.name, 'versions', '--json'], 'checking published versions');
  if (publishedVersions(versions.stdout).includes(pkg.version)) {
    const found = npm(
      ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json'],
      'checking the existing package integrity',
    );
    let remoteIntegrity;
    try {
      remoteIntegrity = JSON.parse(found.stdout);
    } catch {
      throw new Error('npm returned invalid JSON for dist.integrity');
    }
    assertMatchingIntegrity(localIntegrity, remoteIntegrity);
    process.stdout.write(
      `${pkg.name}@${pkg.version} already has the verified tarball integrity; continuing\n`,
    );
    return;
  }

  npm(['publish', artifact], 'publishing the verified tarball', { stdio: 'inherit' });
}

function npm(args, operation, options = {}) {
  const child = spawnSync('npm', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (child.error || child.status !== 0) {
    // Registry/CLI diagnostics can contain request URLs or configuration.
    // The privileged job needs a safe, stable failure, not reflected output.
    throw new Error(
      `${operation} failed${child.status === null ? '' : ` with exit ${child.status}`}`,
      { cause: child.error },
    );
  }
  return child;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) publishPackage(process.argv[2]);
