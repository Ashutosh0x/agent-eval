import { describe, it, expect, beforeAll } from 'vitest';
import { InMemoryKeySource, Signer } from '../../evidence/index.js';
import {
  issuePassport,
  passportId,
  verifyPassport,
  type IssuePassportInput,
  type Passport,
} from '../../provenance/passport.js';
import { ACCELERATOR_VENDORS, type DeploymentIdentity, type ModelIdentity } from '../../provenance/identity.js';

const MODEL: ModelIdentity = {
  repository: 'Qwen/Qwen3-8B',
  origin: 'hub',
  commitSha: 'a'.repeat(40),
};

const DEPLOYMENT: DeploymentIdentity = {
  provider: 'vllm',
  servedModelId: 'Qwen/Qwen3-8B',
  runtime: { engine: 'vllm', engineVersion: '0.6.0', precision: 'bf16' },
  accelerator: { vendor: ACCELERATOR_VENDORS.NVIDIA, model: 'H100', count: 1 },
  endpoint: 'http://gpu-1:8000/v1',
};

const EVIDENCE = {
  merkleRoot: 'd'.repeat(64),
  treeSize: 128,
  bundleId: 'bundle_1',
};

function input(over: Partial<IssuePassportInput> = {}): IssuePassportInput {
  return {
    passportId: 'psp_test',
    issuerVersion: '1.0.0',
    model: MODEL,
    deployment: DEPLOYMENT,
    benchmarkId: 'terminal-bench',
    benchmarkVersion: '2.1',
    benchmarkDigest: `sha256:${'b'.repeat(64)}`,
    metrics: { successRate: 0.8, tasksAttempted: 100, tasksSucceeded: 80, trials: 5 },
    statistics: {
      confidenceIntervalLow: 0.71,
      confidenceIntervalHigh: 0.87,
      confidenceLevel: 0.95,
      method: 'wilson',
    },
    ...over,
  };
}

let signer: Signer;
let publicKey: string;

beforeAll(async () => {
  const keys = InMemoryKeySource.generate();
  signer = new Signer(keys);
  publicKey = keys.publicKeyPem();
});

describe('a passport cannot claim verification it cannot support', () => {
  it('is AGENT_EVAL_VERIFIED only when evidence is attached', async () => {
    const p = await issuePassport(signer, input({ evidence: EVIDENCE }));
    expect(p.payload.provenanceClass).toBe('AGENT_EVAL_VERIFIED');
  });

  it('degrades to COMMUNITY_REPORTED with no evidence', async () => {
    const p = await issuePassport(signer, input());
    expect(p.payload.provenanceClass).toBe('COMMUNITY_REPORTED');
    expect(p.payload.caveats.join(' ')).toMatch(/cannot be verified offline/);
  });

  it('degrades to SELF_REPORTED when the measured party supplied the numbers', async () => {
    const p = await issuePassport(signer, input({ selfReported: true }));
    expect(p.payload.provenanceClass).toBe('SELF_REPORTED');
  });

  it('will not promote a self-reported claim even if evidence is attached', async () => {
    // Evidence supplied alongside an import attests to the import, not to an
    // execution. Promoting here would launder a vendor's own number.
    const p = await issuePassport(signer, input({ selfReported: true, evidence: EVIDENCE }));
    expect(p.payload.provenanceClass).toBe('SELF_REPORTED');
  });

  it('treats empty evidence as no evidence', async () => {
    const p = await issuePassport(
      signer,
      input({ evidence: { merkleRoot: '', treeSize: 0, bundleId: 'x' } }),
    );
    expect(p.payload.provenanceClass).not.toBe('AGENT_EVAL_VERIFIED');
  });

  it('offers no input field that sets the class directly', () => {
    // The structural guarantee. If a `provenanceClass` input ever appears,
    // every honesty property above becomes advisory.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'provenance', 'passport.ts'),
      'utf8',
    ) as string;
    const iface = src
      .slice(
        src.indexOf('export interface IssuePassportInput'),
        src.indexOf('function deriveProvenanceClass'),
      )
      // Comments legitimately discuss verification; it is a declared FIELD
      // that would break the guarantee.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(iface).not.toContain('provenanceClass');
    expect(iface).not.toMatch(/^\s*verified/m);
  });
});

describe('signature and tamper detection', () => {
  let good: Passport;
  beforeAll(async () => {
    good = await issuePassport(signer, input({ evidence: EVIDENCE }));
  });

  it('verifies an untouched passport', () => {
    const v = verifyPassport(good, publicKey);
    expect(v.valid).toBe(true);
    expect(v.checks.every((c) => c.passed)).toBe(true);
  });

  it('detects an edited score', () => {
    const tampered: Passport = {
      ...good,
      payload: { ...good.payload, metrics: { ...good.payload.metrics, successRate: 0.99 } },
    };
    const v = verifyPassport(tampered, publicKey);
    expect(v.valid).toBe(false);
    expect(v.checks.find((c) => c.name === 'signature')?.passed).toBe(false);
  });

  it('detects an upgraded provenance class', async () => {
    // The attack this defends: take a passport that is NOT verified, change
    // one word, and publish it as independently verified. It has to start
    // from a weaker passport — rewriting a verified one to "verified" is a
    // no-op and would prove nothing.
    const weak = await issuePassport(signer, input());
    expect(weak.payload.provenanceClass).toBe('COMMUNITY_REPORTED');

    const tampered: Passport = {
      ...weak,
      payload: { ...weak.payload, provenanceClass: 'AGENT_EVAL_VERIFIED' },
    };
    const v = verifyPassport(tampered, publicKey);
    expect(v.valid).toBe(false);
    // Caught twice over: the signature no longer matches, AND the claim is
    // unsupported by the evidence. Either alone would be enough.
    expect(v.checks.find((c) => c.name === 'signature')?.passed).toBe(false);
    expect(v.checks.find((c) => c.name === 'provenance_class')?.passed).toBe(false);
  });

  it('rejects a wrong public key', async () => {
    const otherKeys = InMemoryKeySource.generate('other-key');
    const v = verifyPassport(good, otherKeys.publicKeyPem());
    expect(v.valid).toBe(false);
  });
});

describe('a valid signature over a false claim still fails', () => {
  it('catches AGENT_EVAL_VERIFIED with no evidence, even when properly signed', async () => {
    // This is the case a signature alone cannot catch: the issuer itself
    // asserting a class its artifact does not support. Constructed by signing
    // a hand-built payload, which is what a malicious issuer would do.
    const honest = await issuePassport(signer, input());
    const lying = await signer.sign({
      ...honest.payload,
      provenanceClass: 'AGENT_EVAL_VERIFIED' as const,
    });

    const v = verifyPassport(lying as Passport, publicKey);
    // The signature is genuinely valid...
    expect(v.checks.find((c) => c.name === 'signature')?.passed).toBe(true);
    // ...and the passport is still rejected.
    expect(v.valid).toBe(false);
    expect(v.checks.find((c) => c.name === 'provenance_class')?.passed).toBe(false);
    expect(v.supportedClass).toBe('COMMUNITY_REPORTED');
  });

  it('reports the class the evidence actually supports', async () => {
    const p = await issuePassport(signer, input({ evidence: EVIDENCE }));
    expect(verifyPassport(p, publicKey).supportedClass).toBe('AGENT_EVAL_VERIFIED');
  });
});

describe('digests are recomputed, not trusted', () => {
  it('catches a model digest that does not match its identity block', async () => {
    // Means the two halves were assembled from different runs.
    const p = await issuePassport(signer, input({ evidence: EVIDENCE }));
    const mismatched = await signer.sign({
      ...p.payload,
      digests: { ...p.payload.digests, model: `sha256:${'0'.repeat(64)}` },
    });
    const v = verifyPassport(mismatched as Passport, publicKey);
    expect(v.checks.find((c) => c.name === 'model_digest')?.passed).toBe(false);
    expect(v.valid).toBe(false);
  });

  it('catches a deployment digest mismatch', async () => {
    const p = await issuePassport(signer, input({ evidence: EVIDENCE }));
    const mismatched = await signer.sign({
      ...p.payload,
      digests: { ...p.payload.digests, deployment: `sha256:${'0'.repeat(64)}` },
    });
    expect(verifyPassport(mismatched as Passport, publicKey).valid).toBe(false);
  });
});

describe('internal arithmetic is checked', () => {
  it('catches a success rate that contradicts the task counts', async () => {
    const p = await issuePassport(signer, input({ evidence: EVIDENCE }));
    const inconsistent = await signer.sign({
      ...p.payload,
      metrics: { ...p.payload.metrics, successRate: 0.95 },
    });
    const v = verifyPassport(inconsistent as Passport, publicKey);
    expect(v.checks.find((c) => c.name === 'metrics_consistency')?.passed).toBe(false);
  });

  it('catches an inverted confidence interval', async () => {
    const p = await issuePassport(
      signer,
      input({
        evidence: EVIDENCE,
        statistics: {
          confidenceIntervalLow: 0.9,
          confidenceIntervalHigh: 0.1,
          confidenceLevel: 0.95,
          method: 'wilson',
        },
      }),
    );
    const v = verifyPassport(p, publicKey);
    expect(v.checks.find((c) => c.name === 'interval_sanity')?.passed).toBe(false);
  });

  it('accepts zero attempts without dividing by zero', async () => {
    const p = await issuePassport(
      signer,
      input({
        evidence: EVIDENCE,
        metrics: { successRate: 0, tasksAttempted: 0, tasksSucceeded: 0, trials: 1 },
      }),
    );
    expect(verifyPassport(p, publicKey).checks.find((c) => c.name === 'metrics_consistency')?.passed).toBe(true);
  });
});

describe('caveats surface what weakens a result', () => {
  it('warns about a single trial', async () => {
    const p = await issuePassport(
      signer,
      input({ metrics: { successRate: 1, tasksAttempted: 50, tasksSucceeded: 50, trials: 1 } }),
    );
    expect(p.payload.caveats.join(' ')).toMatch(/single trial/i);
  });

  it('warns about a small sample', async () => {
    const p = await issuePassport(
      signer,
      input({ metrics: { successRate: 1, tasksAttempted: 3, tasksSucceeded: 3, trials: 5 } }),
    );
    expect(p.payload.caveats.join(' ')).toMatch(/3 task/);
  });

  it('warns about a wide interval', async () => {
    const p = await issuePassport(
      signer,
      input({
        statistics: {
          confidenceIntervalLow: 0.3,
          confidenceIntervalHigh: 0.9,
          confidenceLevel: 0.95,
          method: 'wilson',
        },
      }),
    );
    expect(p.payload.caveats.join(' ')).toMatch(/indicative only/);
  });

  it('warns about an unpinned model', async () => {
    const p = await issuePassport(
      signer,
      input({ model: { repository: 'openai/gpt', origin: 'proprietary_api' } }),
    );
    expect(p.payload.caveats.join(' ')).toMatch(/No revision was recorded/);
    expect(p.payload.reproducibility.pinning).toBe('unpinned');
  });

  it('says cost is unknown rather than omitting the subject', async () => {
    const p = await issuePassport(signer, input());
    expect(p.payload.caveats.join(' ')).toMatch(/reported as unknown/);
  });

  it('a strong result still carries its provenance caveat if unverified', async () => {
    // A clean measurement is not the same as a verified one.
    const p = await issuePassport(
      signer,
      input({ metrics: { successRate: 0.9, tasksAttempted: 500, tasksSucceeded: 450, trials: 10 } }),
    );
    expect(p.payload.caveats.length).toBeGreaterThan(0);
  });
});

describe('the payload carries no secrets', () => {
  it('serialises without anything credential-shaped', async () => {
    const p = await issuePassport(
      signer,
      input({
        evidence: EVIDENCE,
        deployment: { ...DEPLOYMENT, endpoint: 'http://gpu-1:8000/v1' },
      }),
    );
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/api[_-]?key/i);
    expect(json).not.toMatch(/bearer/i);
    expect(json).not.toMatch(/sk-/);
  });
});

describe('passportId', () => {
  it('is deterministic for the same inputs', () => {
    const args = { execution: 'sha256:a', benchmarkDigest: 'sha256:b', issuedAt: '2026-09-05T00:00:00Z' };
    expect(passportId(args)).toBe(passportId({ ...args }));
  });

  it('differs when the benchmark differs', () => {
    const base = { execution: 'sha256:a', issuedAt: '2026-09-05T00:00:00Z' };
    expect(passportId({ ...base, benchmarkDigest: 'sha256:b' })).not.toBe(
      passportId({ ...base, benchmarkDigest: 'sha256:c' }),
    );
  });
});
