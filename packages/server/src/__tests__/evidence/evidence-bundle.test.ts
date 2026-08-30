/**
 * End-to-end: produce a bundle, then verify it the way an auditor would --
 * with nothing but the bundle and a public key.
 *
 * The tampering cases are the point. A bundle format that only gets tested on
 * honest input tells you nothing about whether it would catch a dishonest one.
 */

import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../evidence/audit-log.js';
import {
  MINIMUM_RETENTION_DAYS,
  STANDARD_MAPPINGS,
  bundleDigest,
  createBundle,
  verifyBundle,
} from '../../evidence/evidence-bundle.js';
import type { EvidenceBundle } from '../../evidence/evidence-bundle.js';
import { createManifest, hashSplit, comparable } from '../../evidence/reproducibility.js';
import { InMemoryKeySource, Signer } from '../../evidence/signer.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);

function manifest(overrides: Record<string, unknown> = {}) {
  return createManifest({
    runId: 'run-001',
    environment: { reference: 'ghcr.io/org/env:1.0.0', digest: DIGEST, openEnvSpecVersion: 1 },
    model: { identifier: 'anthropic/claude-sonnet-4-5', sampling: { temperature: 0, top_p: 1 } },
    taskSet: {
      id: 'swe-bench-verified',
      version: '2026.01',
      split: 'held-out',
      splitHash: hashSplit(['task-1', 'task-2', 'task-3']),
      taskCount: 3,
    },
    verifier: {
      id: 'pytest-verifier',
      version: '3.1.0',
      assurance: { isomorphicPerturbationTested: true, fuzzed: true, canaryTasksIncluded: true },
    },
    seed: 42,
    toolchain: { 'agent-eval': '1.0.0', 'inspect-ai': '0.3.0' },
    isolationBackend: 'firecracker',
    createdAt: new Date(Date.UTC(2026, 5, 1)),
    ...overrides,
  } as Parameters<typeof createManifest>[0]);
}

async function buildBundle(): Promise<{ bundle: EvidenceBundle; publicKey: string; log: AuditLog }> {
  const log = new AuditLog();
  log.append({ action: 'run.started', actor: 'ci@example.test', tenantId: 't1', subject: 'run-001' });
  log.append({
    action: 'tool.called',
    actor: 'agent',
    tenantId: 't1',
    subject: 'run-001',
    payload: { tool: 'bash', command: 'pytest -q' },
  });
  log.append({
    action: 'approval.granted',
    actor: 'reviewer@example.test',
    tenantId: 't1',
    subject: 'run-001',
    payload: { gatedAction: 'write:production' },
  });
  log.append({ action: 'run.completed', actor: 'ci@example.test', tenantId: 't1', subject: 'run-001' });

  const entries = [...log.all()];
  const inclusionProofs = Object.fromEntries(entries.map((e) => [e.seq, log.inclusionProof(e.seq)]));

  const keySource = InMemoryKeySource.generate('kms-key-1');
  const signer = new Signer(keySource);
  const generatedAt = new Date(Date.UTC(2026, 5, 1));

  const bundle = await createBundle(
    {
      bundleId: 'bundle-001',
      tenantId: 't1',
      runId: 'run-001',
      manifest: manifest(),
      entries,
      logRoot: log.root(),
      logSize: log.size,
      inclusionProofs,
      retention: {
        retainUntil: new Date(generatedAt.getTime() + 200 * 86_400_000),
        policy: 'eu-ai-act-art-19',
        wormAnchored: true,
      },
      generatedAt,
    },
    signer,
  );

  return { bundle, publicKey: keySource.publicKeyPem(), log };
}

describe('evidence bundle', () => {
  it('verifies with only the bundle and a public key', async () => {
    const { bundle, publicKey } = await buildBundle();
    const result = verifyBundle(bundle, publicKey);
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.checks).toEqual({
      signature: true,
      chain: true,
      inclusion: true,
      manifest: true,
      retention: true,
    });
  });

  it('fails against a different public key', async () => {
    const { bundle } = await buildBundle();
    const other = InMemoryKeySource.generate('attacker');
    const result = verifyBundle(bundle, other.publicKeyPem());
    expect(result.valid).toBe(false);
    expect(result.checks.signature).toBe(false);
  });

  it('detects an edited audit entry inside a signed bundle', async () => {
    const { bundle, publicKey } = await buildBundle();
    const tampered = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    tampered.payload.entries[1]!.payload = { tool: 'bash', command: 'rm -rf /' };

    const result = verifyBundle(tampered, publicKey);
    expect(result.valid).toBe(false);
    // The signature covers the whole payload, so this breaks several checks at
    // once -- each independently sufficient.
    expect(result.checks.signature).toBe(false);
    expect(result.checks.chain).toBe(false);
  });

  it('detects an entry swapped for one from another log', async () => {
    const { bundle, publicKey } = await buildBundle();
    const tampered = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    // Keep the chain superficially intact but break the Merkle inclusion.
    tampered.payload.logRoot = 'b'.repeat(64);

    const result = verifyBundle(tampered, publicKey);
    expect(result.valid).toBe(false);
    expect(result.checks.inclusion).toBe(false);
  });

  it('detects a substituted manifest', async () => {
    const { bundle, publicKey } = await buildBundle();
    const tampered = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    tampered.payload.manifest.model.identifier = 'a-different-model';

    const result = verifyBundle(tampered, publicKey);
    expect(result.valid).toBe(false);
    expect(result.checks.manifest).toBe(false);
  });

  it('survives a JSON round-trip when untampered', async () => {
    const { bundle, publicKey } = await buildBundle();
    const roundTripped = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    expect(verifyBundle(roundTripped, publicKey).valid).toBe(true);
  });

  it('refuses to sign a bundle over a broken chain', async () => {
    const log = new AuditLog();
    log.append({ action: 'a', actor: 'u', tenantId: 't1' });
    log.append({ action: 'b', actor: 'u', tenantId: 't1' });
    const entries = JSON.parse(JSON.stringify(log.all()));
    entries[0].actor = 'someone-else';

    const signer = new Signer(InMemoryKeySource.generate());
    await expect(
      createBundle(
        {
          bundleId: 'b',
          tenantId: 't1',
          runId: 'r',
          manifest: manifest(),
          entries,
          logRoot: log.root(),
          logSize: log.size,
          inclusionProofs: { 0: log.inclusionProof(0), 1: log.inclusionProof(1) },
          retention: {
            retainUntil: new Date(Date.now() + 200 * 86_400_000),
            policy: 'p',
            wormAnchored: true,
          },
        },
        signer,
      ),
    ).rejects.toThrow(/broken chain/);
  });

  it('refuses retention below the Article 19 floor', async () => {
    const log = new AuditLog();
    log.append({ action: 'a', actor: 'u', tenantId: 't1' });
    const signer = new Signer(InMemoryKeySource.generate());
    const generatedAt = new Date(Date.UTC(2026, 5, 1));

    await expect(
      createBundle(
        {
          bundleId: 'b',
          tenantId: 't1',
          runId: 'r',
          manifest: manifest(),
          entries: [...log.all()],
          logRoot: log.root(),
          logSize: log.size,
          inclusionProofs: { 0: log.inclusionProof(0) },
          retention: {
            retainUntil: new Date(generatedAt.getTime() + 30 * 86_400_000),
            policy: 'too-short',
            wormAnchored: false,
          },
          generatedAt,
        },
        signer,
      ),
    ).rejects.toThrow(new RegExp(`${MINIMUM_RETENTION_DAYS}`));
  });

  it('refuses an entry with no inclusion proof', async () => {
    const log = new AuditLog();
    log.append({ action: 'a', actor: 'u', tenantId: 't1' });
    log.append({ action: 'b', actor: 'u', tenantId: 't1' });
    const signer = new Signer(InMemoryKeySource.generate());

    await expect(
      createBundle(
        {
          bundleId: 'b',
          tenantId: 't1',
          runId: 'r',
          manifest: manifest(),
          entries: [...log.all()],
          logRoot: log.root(),
          logSize: log.size,
          inclusionProofs: { 0: log.inclusionProof(0) },
          retention: {
            retainUntil: new Date(Date.now() + 200 * 86_400_000),
            policy: 'p',
            wormAnchored: true,
          },
        },
        signer,
      ),
    ).rejects.toThrow(/entry 1 has no inclusion proof/);
  });

  it('gives the same digest for the same contents', async () => {
    const { bundle } = await buildBundle();
    const copy = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    expect(bundleDigest(copy)).toBe(bundleDigest(bundle));
  });
});

describe('regulatory mappings', () => {
  it('never claims more than the text requires', () => {
    // Article 12 asks for automatic logging, not tamper-evidence. A bundle
    // that claims otherwise misstates the regulation to the person least able
    // to catch it.
    const art12 = STANDARD_MAPPINGS.filter((m) => m.provision === 'EU AI Act Art. 12');
    const tamperClaim = art12.find((m) => m.evidence.includes('hash-chained'));
    expect(tamperClaim?.strength).toBe('exceeds');
    expect(tamperClaim?.caveat).toMatch(/does not require tamper-evidence/);
  });

  it('marks organisational obligations as supported, not satisfied', () => {
    for (const provision of ['EU AI Act Art. 14', 'EU AI Act Art. 17', 'SR 11-7']) {
      const mappings = STANDARD_MAPPINGS.filter((m) => m.provision === provision);
      expect(mappings.length).toBeGreaterThan(0);
      for (const m of mappings) {
        expect(m.strength, `${provision} must not claim to satisfy`).toBe('supports');
        expect(m.caveat, `${provision} needs a stated limit`).toBeDefined();
      }
    }
  });

  it('gives every non-satisfying mapping a caveat', () => {
    for (const m of STANDARD_MAPPINGS) {
      if (m.strength !== 'satisfies') {
        expect(m.caveat, `${m.provision} (${m.strength}) has no caveat`).toBeDefined();
      }
    }
  });
});

describe('reproducibility manifest', () => {
  it('rejects an image referenced by tag instead of digest', () => {
    expect(() =>
      manifest({ environment: { reference: 'env:latest', digest: 'latest' } }),
    ).toThrow(/must be pinned/);
  });

  it('rejects a run with no toolchain recorded', () => {
    expect(() => manifest({ toolchain: {} })).toThrow(/toolchain/);
  });

  it('rejects an unattributed run', () => {
    expect(() => manifest({ runId: '' })).toThrow(/runId/);
  });

  it('detects a changed split', () => {
    const a = hashSplit(['t1', 't2', 't3']);
    const b = hashSplit(['t1', 't2']);
    expect(a).not.toBe(b);
  });

  it('treats a reordered split as a different split', () => {
    expect(hashSplit(['a', 'b'])).not.toBe(hashSplit(['b', 'a']));
  });

  it('calls two runs comparable only when nothing that moves a score changed', () => {
    const base = manifest();
    expect(comparable(base, manifest()).comparable).toBe(true);

    const differentSampling = manifest({
      model: { identifier: 'anthropic/claude-sonnet-4-5', sampling: { temperature: 1 } },
    });
    const result = comparable(base, differentSampling);
    expect(result.comparable).toBe(false);
    expect(result.differences).toContain('model.sampling');
  });

  it('flags a changed isolation backend as non-comparable', () => {
    // Network and filesystem behaviour differ between backends, so a score
    // moving across them is not evidence the agent changed.
    const result = comparable(manifest(), manifest({ isolationBackend: 'gvisor' }));
    expect(result.comparable).toBe(false);
    expect(result.differences).toContain('isolationBackend');
  });
});
