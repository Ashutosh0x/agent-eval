/**
 * API key tests.
 *
 * The load-bearing ones are about what is *not* returned and *not* stored. A
 * credential store is defined by its leaks, so most of these assert absence.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/app.js';
import {
  type ApiKeyRecord,
  InMemoryApiKeyStore,
  KEY_PREFIX,
  hashSecret,
  secretMatches,
} from '../../auth/api-keys.js';
import { InMemoryKeySource, Signer } from '../../evidence/index.js';
import { createInMemoryStores, type InMemoryAuditStore, type Stores } from '../../store/index.js';

const FULL =
  'Bearer acme:owner@acme.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read,splits:held-out';
const LIMITED = 'Bearer acme:limited@acme.test:runs:read,runs:write';
const READER = 'Bearer acme:reader@acme.test:runs:read';
const OTHER_TENANT = 'Bearer rival:someone@rival.test:runs:read,runs:write';

let app: FastifyInstance;
let stores: Stores & { audit: InMemoryAuditStore };
let apiKeys: InMemoryApiKeyStore;

beforeEach(async () => {
  stores = createInMemoryStores();
  apiKeys = new InMemoryApiKeyStore();
  app = await buildApp({
    stores,
    signer: new Signer(InMemoryKeySource.generate('k')),
    apiKeys,
    docs: false,
  });
  await app.ready();
});

async function createKey(auth = FULL, body: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { authorization: auth },
    payload: { name: 'CI runner', scopes: ['runs:read', 'audit:read'], ...body },
  });
}

describe('secret handling', () => {
  it('returns the plaintext exactly once, on creation', async () => {
    const res = await createKey();
    expect(res.statusCode).toBe(201);
    const { key, secret } = res.json();
    expect(secret).toMatch(new RegExp(`^${KEY_PREFIX}`));
    expect(secret.length).toBeGreaterThan(40);

    // Every subsequent read path must not carry it.
    const list = await app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: FULL },
    });
    expect(JSON.stringify(list.json())).not.toContain(secret);

    const one = await app.inject({
      method: 'GET',
      url: `/v1/api-keys/${key.id}`,
      headers: { authorization: FULL },
    });
    expect(JSON.stringify(one.json())).not.toContain(secret);
  });

  it('never returns the hash either', async () => {
    const { key } = (await createKey()).json();
    const one = await app.inject({
      method: 'GET',
      url: `/v1/api-keys/${key.id}`,
      headers: { authorization: FULL },
    });
    expect(one.json().hashedSecret).toBeUndefined();
    expect(JSON.stringify(one.json())).not.toContain('hashedSecret');
  });

  it('stores a hash, never the plaintext', async () => {
    const { secret } = (await createKey()).json();
    const result = await apiKeys.authenticate(secret);
    expect(result.ok).toBe(true);
    const record = (result as { ok: true; key: ApiKeyRecord }).key;
    expect(record.hashedSecret).toBe(hashSecret(secret));
    expect(record.hashedSecret).not.toBe(secret);
    // Nothing in the stored record is the secret.
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it('masks the key without revealing it', async () => {
    const { key, secret } = (await createKey()).json();
    expect(key.masked).toMatch(/^ae_live_•+/);
    expect(key.masked.endsWith(secret.slice(-4))).toBe(true);
    expect(key.masked).not.toContain(secret.slice(8, 20));
  });

  it('keeps the secret out of the audit log', async () => {
    // An audit entry naming a live credential would defeat not storing it.
    const { secret } = (await createKey()).json();
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: FULL },
    });
    expect(JSON.stringify(audit.json())).not.toContain(secret);
    const entry = audit.json().items.find((e: { action: string }) => e.action === 'api-key.created');
    expect(entry).toBeDefined();
    expect(entry.payload.masked).toMatch(/•/);
  });

  it('generates a distinct secret every time', async () => {
    const a = (await createKey()).json().secret;
    const b = (await createKey()).json().secret;
    expect(a).not.toBe(b);
  });

  it('compares secrets in constant time', () => {
    const hashed = hashSecret('ae_live_correct');
    expect(secretMatches('ae_live_correct', hashed)).toBe(true);
    expect(secretMatches('ae_live_wrong', hashed)).toBe(false);
    // A length mismatch must not throw out of timingSafeEqual.
    expect(secretMatches('', hashed)).toBe(false);
  });
});

describe('authentication with a key', () => {
  it('resolves a valid secret', async () => {
    const { key, secret } = (await createKey()).json();
    const result = await apiKeys.authenticate(secret);
    expect(result.ok).toBe(true);
    const record = (result as { ok: true; key: ApiKeyRecord }).key;
    expect(record.id).toBe(key.id);
    expect(record.scopes).toEqual(['runs:read', 'audit:read']);
  });

  it('rejects an unknown secret', async () => {
    await createKey();
    expect(await apiKeys.authenticate(`${KEY_PREFIX}not-a-real-key`)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('rejects a secret with the wrong prefix', async () => {
    expect(await apiKeys.authenticate('bearer-token-not-an-api-key')).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('rejects a revoked key', async () => {
    const { key, secret } = (await createKey()).json();
    await app.inject({
      method: 'POST',
      url: `/v1/api-keys/${key.id}/revoke`,
      headers: { authorization: FULL },
    });
    // A revoked key is distinguishable from a typo: the operator debugging a
    // broken integration needs to know which of the two happened.
    expect(await apiKeys.authenticate(secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('records last used', async () => {
    const { key, secret } = (await createKey()).json();
    expect((await apiKeys.get('acme', key.id))?.lastUsedAt).toBeUndefined();
    await apiKeys.authenticate(secret);
    expect((await apiKeys.get('acme', key.id))?.lastUsedAt).toBeDefined();
  });
});

describe('scope handling', () => {
  it('refuses to mint a key more capable than the caller', async () => {
    // Without this, an actor with one scope could issue themselves an
    // all-scope credential — privilege escalation through the key endpoint.
    const res = await createKey(LIMITED, {
      scopes: ['runs:read', 'evidence:generate', 'approvals:decide'],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/cannot grant scopes you do not hold/);
    expect(res.json().detail).toContain('evidence:generate');
  });

  it('allows a subset of the caller scopes', async () => {
    const res = await createKey(LIMITED, { scopes: ['runs:read'] });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a scope the control plane does not recognise', async () => {
    const res = await createKey(FULL, { scopes: ['runs:read', 'invented:scope'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().field).toBe('scopes');
  });

  it('rejects a key with no scopes', async () => {
    const res = await createKey(FULL, { scopes: [] });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an unnamed key', async () => {
    const res = await createKey(FULL, { name: '   ' });
    expect(res.statusCode).toBe(422);
  });

  it('requires runs:write to create', async () => {
    const res = await createKey(READER);
    expect(res.statusCode).toBe(403);
  });
});

describe('tenant isolation', () => {
  it('does not list another tenant keys', async () => {
    await createKey(FULL);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: OTHER_TENANT },
    });
    expect(res.json().items).toHaveLength(0);
  });

  it('does not let another tenant read a key by id', async () => {
    const { key } = (await createKey(FULL)).json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/api-keys/${key.id}`,
      headers: { authorization: OTHER_TENANT },
    });
    // 404, not 403: a 403 would confirm the id is real.
    expect(res.statusCode).toBe(404);
  });

  it('does not let another tenant revoke a key', async () => {
    const { key } = (await createKey(FULL)).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/api-keys/${key.id}/revoke`,
      headers: { authorization: OTHER_TENANT },
    });
    expect(res.statusCode).toBe(404);
    expect((await apiKeys.get('acme', key.id))?.revokedAt).toBeUndefined();
  });
});

describe('revocation', () => {
  it('marks revoked rather than deleting', async () => {
    // The record is evidence the credential existed and who ended it.
    const { key } = (await createKey()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/api-keys/${key.id}/revoke`,
      headers: { authorization: FULL },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revokedAt).toBeDefined();
    expect(res.json().revokedBy).toBe('owner@acme.test');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: FULL },
    });
    expect(list.json().items).toHaveLength(1);
  });

  it('refuses to revoke twice', async () => {
    const { key } = (await createKey()).json();
    const revoke = () =>
      app.inject({
        method: 'POST',
        url: `/v1/api-keys/${key.id}/revoke`,
        headers: { authorization: FULL },
      });
    expect((await revoke()).statusCode).toBe(200);
    expect((await revoke()).statusCode).toBe(409);
  });

  it('404s on an unknown key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/api-keys/key_nope/revoke',
      headers: { authorization: FULL },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records the revocation in the audit log', async () => {
    const { key } = (await createKey()).json();
    await app.inject({
      method: 'POST',
      url: `/v1/api-keys/${key.id}/revoke`,
      headers: { authorization: FULL },
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: FULL },
    });
    expect(
      audit.json().items.some((e: { action: string }) => e.action === 'api-key.revoked'),
    ).toBe(true);
  });
});

describe('identity', () => {
  it('reports the caller and every scope with its description', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: LIMITED },
    });
    const me = res.json();
    expect(me.actor).toBe('limited@acme.test');
    expect(me.tenantId).toBe('acme');
    expect(me.scopes).toEqual(['runs:read', 'runs:write']);

    // Every scope the control plane knows, flagged by whether it is held.
    expect(me.availableScopes).toHaveLength(7);
    const held = me.availableScopes.filter((s: { held: boolean }) => s.held);
    expect(held).toHaveLength(2);
    expect(me.availableScopes.every((s: { description: string }) => s.description.length > 0)).toBe(
      true,
    );
  });

  it('flags consequential scopes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: FULL },
    });
    const consequential = res
      .json()
      .availableScopes.filter((s: { consequential: boolean }) => s.consequential)
      .map((s: { scope: string }) => s.scope);
    expect(consequential).toContain('runs:write');
    expect(consequential).toContain('approvals:decide');
    expect(consequential).not.toContain('runs:read');
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });
});
