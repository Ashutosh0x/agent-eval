/**
 * Stored credentials reaching a run.
 *
 * Until this wiring existed the encrypted credential store and the execution
 * path were two systems that never met: a key saved through the dashboard was
 * stored correctly and then ignored, while every run read the process
 * environment. That failure is invisible from either side — the store reports
 * a saved credential, the run reports a real provider error — so the seam
 * between them is what these tests hold.
 */

import { describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../../auth/encryption.js';
import { ProviderCredentialStore } from '../../auth/provider-credentials.js';
import { ModelExecutor, selectExecutor } from '../../worker/executor.js';

const MASTER = Buffer.alloc(32, 3);
const MANIFEST = { model: { identifier: 'ollama/some-model', sampling: {} } };


describe('a run spends the credential it names', () => {
  it('decrypts the stored secret and hands it to the provider', async () => {
    const store = new ProviderCredentialStore(SecretBox.fromKey(MASTER));
    const cred = await store.create('acme', 'someone', {
      providerId: 'openai',
      name: 'Production',
      apiKey: 'sk-the-real-one',
      // Pointed at a closed port. The assertion is about what the executor
      // hands the adapter, and a test suite must not send a credential to a
      // real provider to prove it.
      baseUrl: 'http://127.0.0.1:1',
    });

    const seen: (string | undefined)[] = [];
    const executor = new ModelExecutor(true, async (tenantId, id) => {
      const revealed = await store.revealForProviderCall(tenantId, id);
      seen.push(revealed?.apiKey);
      return revealed;
    });

    await executor.execute('run_1', MANIFEST, { tenantId: 'acme', credentialId: cred.id });

    // The plaintext the provider receives is the one that was sealed, which is
    // the only proof that encryption round-tripped through the run path rather
    // than the store being written and then bypassed.
    expect(seen).toEqual(['sk-the-real-one']);
  });

  it('refuses a credential belonging to another tenant', async () => {
    const store = new ProviderCredentialStore(SecretBox.fromKey(MASTER));
    const cred = await store.create('acme', 'someone', {
      providerId: 'openai',
      name: 'Production',
      apiKey: 'sk-not-yours',
    });

    const executor = new ModelExecutor(true, (tenantId, id) =>
      store.revealForProviderCall(tenantId, id),
    );

    const result = await executor.execute('run_1', MANIFEST, {
      tenantId: 'rival',
      credentialId: cred.id,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/not found for this tenant/);
    // And nothing about the secret reached the audit events.
    expect(JSON.stringify(result.events)).not.toContain('sk-not-yours');
  });

  it('fails loudly when the worker has no credential access', async () => {
    // A worker started without the store must not silently fall back to the
    // environment: the run would then be paid for by a different key than the
    // one it names, and the evidence would say otherwise.
    const executor = new ModelExecutor(true);
    const result = await executor.execute('run_1', MANIFEST, {
      tenantId: 'acme',
      credentialId: 'cred_whatever',
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/without access to the credential store/);
  });

  it('refuses a revoked credential', async () => {
    const store = new ProviderCredentialStore(SecretBox.fromKey(MASTER));
    const cred = await store.create('acme', 'someone', {
      providerId: 'openai',
      name: 'Production',
      apiKey: 'sk-revoked-soon',
    });
    await store.revoke('acme', cred.id, 'someone');

    const executor = new ModelExecutor(true, (tenantId, id) =>
      store.revealForProviderCall(tenantId, id),
    );
    const result = await executor.execute('run_1', MANIFEST, {
      tenantId: 'acme',
      credentialId: cred.id,
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/revoked/i);
  });

  it('records which credential was used, never the credential', async () => {
    const store = new ProviderCredentialStore(SecretBox.fromKey(MASTER));
    const cred = await store.create('acme', 'someone', {
      providerId: 'ollama',
      name: 'Local',
      apiKey: 'sk-should-never-appear',
      baseUrl: 'http://127.0.0.1:1', // Closed port: the call fails fast.
    });

    const executor = new ModelExecutor(true, (tenantId, id) =>
      store.revealForProviderCall(tenantId, id),
    );
    const result = await executor.execute('run_1', MANIFEST, {
      tenantId: 'acme',
      credentialId: cred.id,
    });

    const serialised = JSON.stringify(result.events);
    expect(serialised).toContain(cred.id);
    expect(serialised).not.toContain('sk-should-never-appear');
    // Nor in the failure text the run reports.
    expect(result.reason ?? '').not.toContain('sk-should-never-appear');
  }, 20_000);

  it('is not wired for backends that do not call a provider', () => {
    const resolver = vi.fn();
    // local-process runs code; there is no provider and no credential to spend.
    const local = selectExecutor('local-process', { enabled: true }, true, resolver);
    expect(local).not.toBeInstanceOf(ModelExecutor);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('reaches the model executor for the model backend', () => {
    expect(selectExecutor('model', { enabled: false }, true, vi.fn())).toBeInstanceOf(ModelExecutor);
  });
});
