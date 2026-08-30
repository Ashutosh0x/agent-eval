/**
 * Security tests.
 *
 * Nearly every assertion here is about absence — a secret that is not
 * returned, not logged, not chained, not reachable from another tenant. A
 * credential system is defined by its leaks, so the cases that matter are the
 * ones where something should not be there.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/app.js';
import { InMemoryApiKeyStore, KEY_PREFIX } from '../../auth/api-keys.js';
import { SecretBox, maskSecret, redactSecrets, stripSecrets } from '../../auth/encryption.js';
import { ProviderCredentialStore } from '../../auth/provider-credentials.js';
import { InMemoryKeySource, Signer } from '../../evidence/index.js';
import { createInMemoryStores, type InMemoryAuditStore, type Stores } from '../../store/index.js';

const MASTER = Buffer.alloc(32, 7);
const FULL =
  'Bearer acme:owner@acme.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read,splits:held-out';
const OTHER = 'Bearer rival:x@rival.test:runs:read,runs:write';

let app: FastifyInstance;
let stores: Stores & { audit: InMemoryAuditStore };
let apiKeys: InMemoryApiKeyStore;
let credentials: ProviderCredentialStore;

beforeEach(async () => {
  stores = createInMemoryStores();
  apiKeys = new InMemoryApiKeyStore();
  credentials = new ProviderCredentialStore(SecretBox.fromKey(MASTER));
  app = await buildApp({
    stores,
    signer: new Signer(InMemoryKeySource.generate('k')),
    apiKeys,
    credentials,
    docs: false,
  });
  await app.ready();
});

async function makeKey(body: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { authorization: FULL },
    payload: { name: 'CI', scopes: ['runs:read'], ...body },
  });
  return res.json() as { key: { id: string }; secret: string };
}

describe('an API key actually authenticates', () => {
  it('is accepted as a bearer credential', async () => {
    // Before this existed, keys could be created and revoked but never used:
    // every request fell through to the development token parser, so a
    // revoked key was indistinguishable from a valid one.
    const { secret } = await makeKey();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('carries the tenant and scopes stored with the key, not the caller claim', async () => {
    const { secret } = await makeKey({ scopes: ['runs:read'] });
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(me.json().tenantId).toBe('acme');
    expect(me.json().scopes).toEqual(['runs:read']);
    expect(me.json().actor).toMatch(/^apikey:/);
  });

  it('enforces the key scopes, not the creator scopes', async () => {
    // The creator held runs:write; the key does not.
    const { secret } = await makeKey({ scopes: ['runs:read'] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${secret}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${KEY_PREFIX}totally-made-up` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toMatch(/not recognised/);
  });

  it('rejects a revoked key immediately', async () => {
    const { key, secret } = await makeKey();
    const before = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/v1/api-keys/${key.id}/revoke`,
      headers: { authorization: FULL },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(after.statusCode).toBe(401);
    // A revoked key says so, rather than looking like a typo.
    expect(after.json().detail).toMatch(/revoked/);
  });

  it('rejects an expired key', async () => {
    const { secret } = await makeKey({ expiresInDays: 1 });

    // Move the clock with a Date.now spy rather than fake timers: faking
    // timers freezes the ones Fastify's inject depends on, and the request
    // never resolves — the test hangs instead of failing, and leaves timers
    // faked for everything after it.
    const realNow = Date.now;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 86_400_000);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/runs',
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().detail).toMatch(/expired/);
    } finally {
      spy.mockRestore();
    }
  });

  it('sends WWW-Authenticate when a key is refused', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${KEY_PREFIX}nope` },
    });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="agent-eval"');
  });

  it('records last used only on success', async () => {
    const { key, secret } = await makeKey();
    await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${KEY_PREFIX}wrong` },
    });
    expect((await apiKeys.get('acme', key.id))?.lastUsedAt).toBeUndefined();

    await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect((await apiKeys.get('acme', key.id))?.lastUsedAt).toBeDefined();
  });
});

describe('provider credential encryption', () => {
  it('round-trips through AES-256-GCM', () => {
    const box = SecretBox.fromKey(MASTER);
    const sealed = box.seal('sk-a-real-looking-secret', 'aad');
    expect(JSON.stringify(sealed)).not.toContain('sk-a-real-looking-secret');
    expect(box.open(sealed, 'aad')).toBe('sk-a-real-looking-secret');
  });

  it('refuses to open under different associated data', () => {
    // This is what stops a row moved between tenants from decrypting.
    const box = SecretBox.fromKey(MASTER);
    const sealed = box.seal('secret', 'tenant-a');
    expect(() => box.open(sealed, 'tenant-b')).toThrow(/Could not decrypt/);
  });

  it('detects tampered ciphertext', () => {
    const box = SecretBox.fromKey(MASTER);
    const sealed = box.seal('secret', 'aad');
    const flipped = Buffer.from(sealed.ciphertext, 'base64');
    flipped[0] ^= 0xff;
    expect(() =>
      box.open({ ...sealed, ciphertext: flipped.toString('base64') }, 'aad'),
    ).toThrow(/Could not decrypt/);
  });

  it('refuses to open under a different master key', () => {
    const sealed = SecretBox.fromKey(MASTER).seal('secret', 'aad');
    expect(() => SecretBox.fromKey(Buffer.alloc(32, 9)).open(sealed, 'aad')).toThrow();
  });

  it('uses a fresh IV every time', () => {
    const box = SecretBox.fromKey(MASTER);
    const a = box.seal('same', 'aad');
    const b = box.seal('same', 'aad');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses to store a credential when encryption is unconfigured', async () => {
    // Storing plaintext because configuration was missing is exactly the
    // failure this store exists to prevent, and it would be invisible after.
    const unconfigured = new ProviderCredentialStore(null);
    await expect(
      unconfigured.create('acme', 'me', { providerId: 'openai', name: 'p', apiKey: 'sk-x' }),
    ).rejects.toThrow(/encryption is not configured/i);
  });

  it('allows a credential-free provider without encryption', async () => {
    const unconfigured = new ProviderCredentialStore(null);
    const c = await unconfigured.create('acme', 'me', { providerId: 'ollama', name: 'local' });
    expect(c.masked).toMatch(/no credential/);
  });
});

describe('provider credentials never leave the server', () => {
  const SECRET = 'sk-provider-secret-value-9876';

  async function storeCredential(auth = FULL) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/provider-credentials',
      headers: { authorization: auth },
      payload: { providerId: 'openai', name: 'Production', apiKey: SECRET },
    });
    return res;
  }

  it('is absent from the creation response', async () => {
    const res = await storeCredential();
    expect(res.statusCode).toBe(201);
    expect(res.payload).not.toContain(SECRET);
    expect(res.json().masked).toMatch(/•/);
    // Unlike an agent-eval key, a provider credential is never returned even
    // once: the caller already has it.
    expect(res.json().apiKey).toBeUndefined();
    expect(res.json().sealed).toBeUndefined();
  });

  it('is absent from the list', async () => {
    await storeCredential();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/provider-credentials',
      headers: { authorization: FULL },
    });
    expect(res.payload).not.toContain(SECRET);
    expect(res.payload).not.toContain('ciphertext');
  });

  it('is absent from the provider listing', async () => {
    await storeCredential();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/providers',
      headers: { authorization: FULL },
    });
    expect(res.payload).not.toContain(SECRET);
  });

  it('is absent from the audit chain', async () => {
    await storeCredential();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: FULL },
    });
    expect(res.payload).not.toContain(SECRET);
    const entry = res
      .json()
      .items.find((e: { action: string }) => e.action === 'provider-credential.created');
    expect(entry.payload.masked).toMatch(/•/);
  });

  it('is decryptable only through the named reveal path', async () => {
    const created = (await storeCredential()).json();
    const revealed = await credentials.revealForProviderCall('acme', created.id);
    expect(revealed?.apiKey).toBe(SECRET);
  });

  it('is not reachable by another tenant', async () => {
    const created = (await storeCredential()).json();
    expect(await credentials.revealForProviderCall('rival', created.id)).toBeNull();
    expect(await credentials.get('rival', created.id)).toBeNull();

    const list = await app.inject({
      method: 'GET',
      url: '/v1/provider-credentials',
      headers: { authorization: OTHER },
    });
    expect(list.json().items).toHaveLength(0);
  });

  it('cannot be revoked by another tenant', async () => {
    const created = (await storeCredential()).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/provider-credentials/${created.id}/revoke`,
      headers: { authorization: OTHER },
    });
    expect(res.statusCode).toBe(404);
    expect((await credentials.get('acme', created.id))?.revokedAt).toBeUndefined();
  });

  it('stops decrypting once revoked', async () => {
    const created = (await storeCredential()).json();
    await app.inject({
      method: 'POST',
      url: `/v1/provider-credentials/${created.id}/revoke`,
      headers: { authorization: FULL },
    });
    await expect(credentials.revealForProviderCall('acme', created.id)).rejects.toThrow(/revoked/);
  });
});

describe('provider status is never asserted', () => {
  it('reports a real connection outcome, not a default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/providers/test',
        headers: { authorization: FULL },
        payload: { providerId: 'ollama' },
      });
      expect(res.json().status).not.toBe('connected');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says model listing failed rather than substituting a list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/providers/openai/models',
        headers: { authorization: FULL },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().detail).toMatch(/enter a model id manually/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports no provider as configured without a credential', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/providers',
      headers: { authorization: FULL },
    });
    // Only the runtimes that need no API key report as credential-configured.
    // Note that this says nothing about whether they work: NIM appears here
    // and still has no base URL, which is exactly why the UI keeps "has a
    // credential" and "answered a request" as separate columns.
    const configured = res
      .json()
      .items.filter((p: { credentialConfigured: boolean }) => p.credentialConfigured)
      .map((p: { id: string }) => p.id)
      .sort();
    expect(configured).toEqual(['nim', 'ollama', 'tensorrt-llm', 'vllm']);

    // Every provider that does need a key is absent from that list.
    const keyed = res
      .json()
      .items.filter((p: { requiresApiKey: boolean }) => p.requiresApiKey)
      .map((p: { id: string }) => p.id);
    for (const id of keyed) expect(configured).not.toContain(id);
  });
});

describe('redaction', () => {
  it('strips credential-shaped strings', () => {
    expect(redactSecrets('key sk-abcdefghijklmnop failed')).not.toContain('abcdefghijklmnop');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toContain('[redacted]');
    expect(redactSecrets({ api_key: 'super-secret-value' })).not.toContain('super-secret-value');
    expect(redactSecrets('token AIzaSyAbcdefghijklmnopqrstuvwxyz01')).not.toContain(
      'AIzaSyAbcdefghijklmnopqrstuvwxyz01',
    );
  });

  it('strips sensitive keys from a nested object', () => {
    const stripped = stripSecrets({
      run: 'r1',
      config: { apiKey: 'sk-secret', model: 'some-model' },
      list: [{ secret: 'hidden' }],
    }) as Record<string, never>;
    const text = JSON.stringify(stripped);
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('hidden');
    // Non-sensitive values survive, or the redaction would be useless.
    expect(text).toContain('some-model');
  });

  it('masks without revealing the middle', () => {
    const masked = maskSecret('sk-abcdefghijklmnopqrstuvwxyz');
    expect(masked).not.toContain('efghijklmnopqrstuv');
    expect(masked.endsWith('wxyz')).toBe(true);
  });
});
