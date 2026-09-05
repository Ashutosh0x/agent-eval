import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryModelRegistry,
  ModelRegistryError,
  assertSafeEndpoint,
  endpointIsIdentity,
  modelFingerprint,
  unknownCapabilities,
  type RegisterModelInput,
} from '../../models/registry.js';
import type { TenantContext } from '../../store/index.js';

const alice: TenantContext = { tenantId: 't1', actor: 'alice', scopes: [] };
const bob: TenantContext = { tenantId: 't2', actor: 'bob', scopes: [] };

function cloud(over: Partial<RegisterModelInput> = {}): RegisterModelInput {
  return {
    modelId: 'gpt-frontier',
    displayName: 'GPT Frontier',
    provider: 'openai',
    deploymentType: 'CLOUD_API',
    modelIdentifier: 'gpt-frontier-latest',
    ...over,
  };
}

function local(over: Partial<RegisterModelInput> = {}): RegisterModelInput {
  return {
    modelId: 'qwen-local',
    displayName: 'Qwen 8B (vLLM)',
    provider: 'vllm',
    deploymentType: 'SELF_HOSTED',
    modelIdentifier: 'Qwen/Qwen3-8B',
    baseUrl: 'http://127.0.0.1:8000/v1',
    ...over,
  };
}

describe('registration', () => {
  let reg: InMemoryModelRegistry;
  beforeEach(() => {
    reg = new InMemoryModelRegistry();
  });

  it('registers a cloud model at revision 1', async () => {
    const m = await reg.register(alice, cloud());
    expect(m.revision).toBe(1);
    expect(m.pricing.kind).toBe('unknown');
  });

  it('defaults every capability to unknown, never to supported', async () => {
    // Assuming support is how an incompatible model silently runs.
    const m = await reg.register(alice, cloud());
    expect(m.capabilities.tools).toBe('unknown');
    expect(m.capabilities.vision).toBe('unknown');
    expect(m.capabilities.source).toBe('unknown');
  });

  it('does not fabricate resolvedModelId from the alias', async () => {
    // The whole point of the field is that it came from the provider. Copying
    // the alias into it would fake the pinning it exists to provide.
    const m = await reg.register(alice, cloud());
    expect(m.resolvedModelId).toBeUndefined();
  });

  it('rejects a duplicate id rather than overwriting', async () => {
    await reg.register(alice, cloud());
    await expect(reg.register(alice, cloud())).rejects.toThrow(/already registered/);
  });

  it('isolates tenants', async () => {
    await reg.register(alice, cloud());
    expect(await reg.get(bob, 'gpt-frontier')).toBeNull();
    expect(await reg.list(bob)).toEqual([]);
    // Same id under another tenant is a different model, not a conflict.
    await expect(reg.register(bob, cloud())).resolves.toBeTruthy();
  });

  it.each(['Bad_ID', 'has space', '-leading', '', 'x'.repeat(65)])(
    'rejects malformed modelId %p',
    async (id) => {
      await expect(reg.register(alice, cloud({ modelId: id }))).rejects.toThrow(ModelRegistryError);
    },
  );
});

describe('endpoint is part of identity for self-hosted models', () => {
  let reg: InMemoryModelRegistry;
  beforeEach(() => {
    reg = new InMemoryModelRegistry();
  });

  it('classifies which deployment types need an endpoint', () => {
    expect(endpointIsIdentity('CLOUD_API')).toBe(false);
    for (const d of ['SELF_HOSTED', 'LOCAL', 'OPENAI_COMPATIBLE', 'REMOTE_ENDPOINT'] as const) {
      expect(`${d}:${endpointIsIdentity(d)}`).toBe(`${d}:true`);
    }
  });

  it('refuses a self-hosted model with no baseUrl', async () => {
    // The same weights at a different precision on different hardware is a
    // different system to benchmark.
    await expect(reg.register(alice, local({ baseUrl: undefined }))).rejects.toThrow(/requires a baseUrl/);
  });

  it('allows a cloud model without one', async () => {
    await expect(reg.register(alice, cloud())).resolves.toBeTruthy();
  });
});

describe('fingerprinting', () => {
  const base = {
    provider: 'openai',
    deploymentType: 'CLOUD_API' as const,
    modelIdentifier: 'gpt-frontier',
    resolvedModelId: undefined,
    baseUrl: undefined,
  };

  it('is stable for identical configuration', () => {
    expect(modelFingerprint(base)).toBe(modelFingerprint({ ...base }));
  });

  it('changes when a repointed alias resolves elsewhere', () => {
    // The alias string is unchanged; only what answered it moved. This is the
    // case a leaderboard cannot otherwise see.
    const march = modelFingerprint({ ...base, resolvedModelId: 'gpt-frontier-2026-03-01' });
    const september = modelFingerprint({ ...base, resolvedModelId: 'gpt-frontier-2026-09-01' });
    expect(march).not.toBe(september);
  });

  it('includes the endpoint for self-hosted models', () => {
    const a = { ...base, deploymentType: 'SELF_HOSTED' as const, baseUrl: 'http://gpu-1:8000/v1' };
    const b = { ...a, baseUrl: 'http://gpu-2:8000/v1' };
    expect(modelFingerprint(a)).not.toBe(modelFingerprint(b));
  });

  it('ignores the endpoint for cloud models, where the vendor owns it', () => {
    const a = { ...base, baseUrl: 'https://api.example.com/v1' };
    expect(modelFingerprint(a)).toBe(modelFingerprint(base));
  });

  it('is a pinned sha256', () => {
    expect(modelFingerprint(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('revisions are append-only', () => {
  let reg: InMemoryModelRegistry;
  beforeEach(async () => {
    reg = new InMemoryModelRegistry();
    await reg.register(alice, cloud());
  });

  it('creates a new revision rather than editing', async () => {
    const updated = await reg.update(alice, 'gpt-frontier', { displayName: 'Renamed' });
    expect(updated.revision).toBe(2);
    const original = await reg.getRevision(alice, 'gpt-frontier', 1);
    expect(original?.displayName).toBe('GPT Frontier');
  });

  it('keeps the superseded revision retrievable', async () => {
    // An existing benchmark result points at it.
    await reg.update(alice, 'gpt-frontier', { modelIdentifier: 'gpt-frontier-v2' });
    const v1 = await reg.getRevision(alice, 'gpt-frontier', 1);
    expect(v1?.modelIdentifier).toBe('gpt-frontier-latest');
    expect(v1?.supersededAt).toBeInstanceOf(Date);
  });

  it('marks only the old revision superseded', async () => {
    const v2 = await reg.update(alice, 'gpt-frontier', { displayName: 'X' });
    expect(v2.supersededAt).toBeUndefined();
  });

  it('get() returns the newest revision', async () => {
    await reg.update(alice, 'gpt-frontier', { displayName: 'Second' });
    await reg.update(alice, 'gpt-frontier', { displayName: 'Third' });
    const current = await reg.get(alice, 'gpt-frontier');
    expect(current?.revision).toBe(3);
    expect(current?.displayName).toBe('Third');
  });

  it('validates the merged result, not just the patch', async () => {
    // Switching a cloud model to self-hosted without an endpoint must fail.
    await expect(
      reg.update(alice, 'gpt-frontier', { deploymentType: 'SELF_HOSTED' }),
    ).rejects.toThrow(/requires a baseUrl/);
  });

  it('refuses to update an unregistered model', async () => {
    await expect(reg.update(alice, 'nope', {})).rejects.toThrow(/not registered/);
  });
});

describe('capability probes', () => {
  let reg: InMemoryModelRegistry;
  beforeEach(async () => {
    reg = new InMemoryModelRegistry();
    await reg.register(alice, cloud());
  });

  it('records the resolved id the provider reported', async () => {
    const probed = await reg.recordProbe(alice, 'gpt-frontier', {
      resolvedModelId: 'gpt-frontier-2026-09-03',
      capabilities: { tools: 'supported', vision: 'supported' },
    });
    expect(probed.resolvedModelId).toBe('gpt-frontier-2026-09-03');
    expect(probed.capabilities.tools).toBe('supported');
  });

  it('marks probed capabilities as probed, with a timestamp', async () => {
    // Provenance changes how much weight a claim carries.
    const probed = await reg.recordProbe(alice, 'gpt-frontier', {
      capabilities: { tools: 'supported' },
    });
    expect(probed.capabilities.source).toBe('probed');
    expect(probed.capabilities.probedAt).toBeTruthy();
  });

  it('creates a revision, so the pre-probe state survives', async () => {
    const probed = await reg.recordProbe(alice, 'gpt-frontier', {
      capabilities: { vision: 'unsupported' },
    });
    expect(probed.revision).toBe(2);
    expect((await reg.getRevision(alice, 'gpt-frontier', 1))?.capabilities.vision).toBe('unknown');
  });
});

describe('endpoint safety (SSRF)', () => {
  it('rejects non-http schemes', () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/']) {
      expect(() => assertSafeEndpoint(url)).toThrow(/not allowed|not a valid/);
    }
  });

  it('rejects cloud metadata endpoints', () => {
    // The classic SSRF target: the server would attach stored credentials.
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://foo.internal/v1',
    ]) {
      expect(() => assertSafeEndpoint(url)).toThrow(/metadata endpoint/);
    }
  });

  it('permits loopback by default, because local models are first-class', () => {
    for (const url of ['http://localhost:8000/v1', 'http://127.0.0.1:11434/v1']) {
      expect(() => assertSafeEndpoint(url)).not.toThrow();
    }
  });

  it('can forbid loopback for a hosted deployment', () => {
    expect(() => assertSafeEndpoint('http://localhost:8000/v1', { allowLoopback: false })).toThrow(
      /loopback/,
    );
  });

  it('rejects a malformed URL', () => {
    expect(() => assertSafeEndpoint('not a url')).toThrow(/not a valid URL/);
  });

  it('is enforced at registration, not only when called', async () => {
    const reg = new InMemoryModelRegistry();
    await expect(
      reg.register(alice, local({ baseUrl: 'http://169.254.169.254/v1' })),
    ).rejects.toThrow(/metadata endpoint/);
  });
});

describe('unknownCapabilities', () => {
  it('is unknown for every capability', () => {
    const c = unknownCapabilities();
    for (const [k, v] of Object.entries(c)) {
      if (k === 'requiresApiKey' || k === 'source' || k === 'probedAt') continue;
      expect(`${k}=${v}`).toBe(`${k}=unknown`);
    }
  });
});
