/**
 * Three credentials reach the same user-scoped identity token (I6), and which
 * one a caller holds decides how much a leak costs. The precedence here is
 * narrowest-first, which is also production-first: a per-user identity
 * credential (ADR-0062) names one user and one principal and can do nothing
 * else, an operator credential is the laptop's broader one, and an IdP
 * assertion is dev and the IdP integration.
 *
 * The property worth a test is not that each path works — it is that a client
 * holding the narrow credential never quietly falls back to a broader one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient } from '../src/client.js';
import { startStubControld } from './lib/stub-controld.mjs';

async function withStub(options, body) {
  const stub = await startStubControld(options);
  try {
    await body(stub);
  } finally {
    await stub.close();
  }
}

test('a per-user identity credential takes the ADR-0062 door', async () => {
  await withStub({}, async (stub) => {
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.secret',
    });
    const identity = await client.identityToken();
    assert.equal(identity.userId, 'u-per-user');
    assert.equal(identity.token, 'identity-token-per-user');

    const paths = stub.state.calls.map((c) => c.path);
    assert.ok(paths.includes('/v1/identity/session'));
    assert.ok(
      !paths.includes('/v1/operator/session'),
      'the narrow credential must not also exercise the broad door',
    );
  });
});

test('the narrow credential wins even when a broader one is also configured', async () => {
  await withStub({}, async (stub) => {
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.secret',
      operatorToken: 'rpop1.test.secret',
      idpAssertion: 'vouched',
      userId: 'dev-user',
    });
    await client.identityToken();
    assert.deepEqual(
      stub.state.calls.map((c) => c.path),
      ['/v1/identity/session'],
      'precedence must be narrowest-first, with no second exchange',
    );
  });
});

test('a refused identity credential fails rather than falling back', async () => {
  await withStub({ identityCredential: 'rpop1.ident.correct' }, async (stub) => {
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.wrong',
      operatorToken: 'rpop1.test.secret',
    });
    await assert.rejects(() => client.identityToken(), /bad_operator_token/);
    assert.ok(
      !stub.state.calls.some((c) => c.path === '/v1/operator/session'),
      'a refusal must NOT be retried under a broader credential — that is privilege escalation by fallback',
    );
  });
});

test('the identity token is exchanged once and reused until it nears expiry', async () => {
  await withStub({}, async (stub) => {
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.secret',
    });
    await client.identityToken();
    await client.identityToken();
    await client.identityToken();
    assert.equal(
      stub.state.calls.filter((c) => c.path === '/v1/identity/session').length,
      1,
    );
  });
});

test('concurrent callers share identity and workspace-token exchanges', async () => {
  await withStub({}, async (stub) => {
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.secret',
    });

    const identities = await Promise.all([
      client.identityToken(),
      client.identityToken(),
      client.identityToken(),
    ]);
    assert.equal(new Set(identities.map((identity) => identity.token)).size, 1);
    assert.equal(
      stub.state.calls.filter((call) => call.path === '/v1/identity/session').length,
      1,
      'one expired cache entry must produce one credential exchange',
    );

    stub.state.workspaces.set('ws-existing', {
      id: 'ws-existing',
      name: 'existing',
      forks: [],
      archived: false,
    });
    const biscuits = await Promise.all([
      client.biscuitFor('ws-existing'),
      client.biscuitFor('ws-existing'),
      client.biscuitFor('ws-existing'),
    ]);
    assert.deepEqual(biscuits, [
      'biscuit-ws-existing',
      'biscuit-ws-existing',
      'biscuit-ws-existing',
    ]);
    assert.equal(
      stub.state.calls.filter((call) => call.path === '/v1/workspaces/ws-existing/token').length,
      1,
      'one empty cache entry must produce one workspace-token mint',
    );
  });
});

test('workspace Biscuits remint once inside the expiry safety window', async () => {
  await withStub({}, async (stub) => {
    let now = 1_000_000;
    stub.state.biscuitExpiresAtMs = now + 3_600_000;
    stub.state.workspaces.set('ws-existing', {
      id: 'ws-existing',
      name: 'existing',
      forks: [],
      archived: false,
    });
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.secret',
      now: () => now,
    });

    assert.equal(await client.biscuitFor('ws-existing'), 'biscuit-ws-existing');
    now = stub.state.biscuitExpiresAtMs - 60_000;
    stub.state.biscuitExpiresAtMs = now + 3_600_000;
    const reminted = await Promise.all([
      client.biscuitFor('ws-existing'),
      client.biscuitFor('ws-existing'),
      client.biscuitFor('ws-existing'),
    ]);
    assert.deepEqual(reminted, Array(3).fill('biscuit-ws-existing'));
    assert.equal(
      stub.state.calls.filter((call) => call.path === '/v1/workspaces/ws-existing/token').length,
      2,
      'the near-expiry entry is discarded and concurrent callers coalesce onto one remint',
    );
  });
});

test('an explicit auth rejection remints and retries only a safe read', async () => {
  await withStub({ rejectLineageOnce: true }, async (stub) => {
    stub.state.workspaces.set('ws-existing', {
      id: 'ws-existing',
      name: 'existing',
      forks: [],
      archived: false,
    });
    const client = new ControlClient({
      endpoint: stub.endpoint,
      identityCredential: 'rpop1.ident.secret',
    });
    client.biscuits.set('ws-existing', {
      token: 'old-but-unexpired-biscuit',
      expiresAtMs: Date.now() + 3_600_000,
    });

    assert.equal((await client.lineage('ws-existing')).head_snapshot.id, 'snap-42');
    assert.equal(
      stub.state.calls.filter((call) => call.path.endsWith('/lineage')).length,
      2,
    );
    assert.equal(
      stub.state.calls.filter((call) => call.path.endsWith('/token')).length,
      1,
    );
  });
});

test('lineage sends its Biscuit only in the Authorization header', async () => {
  await withStub({}, async (stub) => {
    const biscuit = 'biscuit-wire-sentinel.%2F?and=query';
    stub.state.workspaces.set('ws-existing', {
      id: 'ws-existing',
      name: 'existing',
      forks: [],
      archived: false,
    });
    const client = new ControlClient({ endpoint: stub.endpoint });
    client.biscuits.set('ws-existing', {
      token: biscuit,
      expiresAtMs: Date.now() + 3_600_000,
    });

    await client.lineage('ws-existing');
    const call = stub.state.calls.find((entry) => entry.path.endsWith('/lineage'));
    assert.equal(call.path, '/v1/workspaces/ws-existing/lineage');
    assert.equal(call.query, '', 'a capability must never enter the request target');
    assert.equal(call.authorization, `Bearer ${biscuit}`);
    assert.doesNotMatch(`${call.path}${call.query}`, /biscuit|token|sentinel/i);
  });
});

test('with no credential at all, the error names what to set', async () => {
  await withStub({}, async (stub) => {
    const client = new ControlClient({ endpoint: stub.endpoint });
    // Naming all three, narrowest first, is the same rule the refusal
    // renderer follows: tell the caller what to do, not merely what failed.
    await assert.rejects(() => client.identityToken(), /REACHPAD_IDENTITY_CREDENTIAL/);
    await assert.rejects(() => client.identityToken(), /REACHPAD_OPERATOR_TOKEN/);
    await assert.rejects(() => client.identityToken(), /REACHPAD_IDP_ASSERTION/);
  });
});
