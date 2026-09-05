import { describe, it, expect } from 'vitest';
import {
  buildCompatibilityMatrix,
  checkCompatibility,
  requirementsFrom,
  type BenchmarkRequirements,
} from '../../models/capabilities.js';
import { unknownCapabilities, type ModelCapabilities } from '../../models/registry.js';

function model(caps: Partial<ModelCapabilities> = {}, over: Record<string, unknown> = {}) {
  return {
    modelId: 'm1',
    displayName: 'Test Model',
    capabilities: { ...unknownCapabilities(), ...caps },
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    ...over,
  };
}

const NEEDS_VISION: BenchmarkRequirements = { required: ['vision'] };

describe('the core rule: never silently run an incompatible model', () => {
  it('excludes a model that does not support a required capability', () => {
    const d = checkCompatibility(model({ vision: 'unsupported' }), NEEDS_VISION);
    expect(d.compatible).toBe(false);
    expect(d.missing).toEqual(['vision']);
  });

  it('names what is missing in the reason, not a generic refusal', () => {
    const d = checkCompatibility(model({ vision: 'unsupported' }), NEEDS_VISION);
    expect(d.reason).toContain('Test Model');
    expect(d.reason).toContain('vision');
  });

  it('admits a model that supports everything required', () => {
    const d = checkCompatibility(
      model({ vision: 'supported', tools: 'supported' }),
      { required: ['vision', 'tools'] },
    );
    expect(d.compatible).toBe(true);
    expect(d.flagged).toBe(false);
  });

  it('imposes no requirement when the benchmark declares none', () => {
    expect(checkCompatibility(model(), {}).compatible).toBe(true);
  });
});

describe('unknown is not supported', () => {
  it('excludes by default', () => {
    // A wrongly excluded model is a visible gap in the matrix; a wrongly
    // included one silently corrupts a score.
    const d = checkCompatibility(model({ vision: 'unknown' }), NEEDS_VISION);
    expect(d.compatible).toBe(false);
    expect(d.unknown).toEqual(['vision']);
    expect(d.missing).toEqual([]);
  });

  it('distinguishes unknown from unsupported in the decision', () => {
    // They are different facts and lead to different fixes: one needs a probe,
    // the other needs a different model.
    const unsup = checkCompatibility(model({ vision: 'unsupported' }), NEEDS_VISION);
    const unk = checkCompatibility(model({ vision: 'unknown' }), NEEDS_VISION);
    expect(unsup.missing).toEqual(['vision']);
    expect(unsup.unknown).toEqual([]);
    expect(unk.missing).toEqual([]);
    expect(unk.unknown).toEqual(['vision']);
  });

  it('can include an unknown capability, but flags the result', () => {
    const d = checkCompatibility(model({ vision: 'unknown' }), NEEDS_VISION, 'include_flagged');
    expect(d.compatible).toBe(true);
    expect(d.flagged).toBe(true);
    expect(d.reason).toMatch(/lower confidence/i);
  });

  it('never flags a fully-verified model', () => {
    const d = checkCompatibility(model({ vision: 'supported' }), NEEDS_VISION, 'include_flagged');
    expect(d.flagged).toBe(false);
  });

  it('still excludes an unsupported capability under include_flagged', () => {
    // Permissiveness about unknown must not leak into a definite "no".
    const d = checkCompatibility(model({ vision: 'unsupported' }), NEEDS_VISION, 'include_flagged');
    expect(d.compatible).toBe(false);
  });
});

describe('context and output budgets', () => {
  it('excludes a model whose context is too small', () => {
    const d = checkCompatibility(model({}, { contextWindow: 8_000 }), { minContextWindow: 128_000 });
    expect(d.compatible).toBe(false);
    expect(d.limits[0]).toContain('8000');
  });

  it('does not assume an unknown context window is adequate', () => {
    // Running a task that overflows produces a truncation the score reads as
    // a capability failure.
    const d = checkCompatibility(model({}, { contextWindow: undefined }), {
      minContextWindow: 32_000,
    });
    expect(d.compatible).toBe(false);
    expect(d.limits[0]).toMatch(/unknown/);
  });

  it('excludes a model whose output budget is too small', () => {
    const d = checkCompatibility(model({}, { maxOutputTokens: 1_000 }), { minOutputTokens: 4_096 });
    expect(d.compatible).toBe(false);
  });

  it('admits a model that meets both budgets exactly', () => {
    const d = checkCompatibility(model({}, { contextWindow: 128_000, maxOutputTokens: 8_192 }), {
      minContextWindow: 128_000,
      minOutputTokens: 8_192,
    });
    expect(d.compatible).toBe(true);
  });
});

describe('requirementsFrom', () => {
  it('maps declared flags to capabilities', () => {
    const r = requirementsFrom({ vision: true, tools: true, minContextWindow: 200_000 });
    expect(r.required).toEqual(['vision', 'tools']);
    expect(r.minContextWindow).toBe(200_000);
  });

  it('omits `required` entirely when nothing is needed', () => {
    expect(requirementsFrom({}).required).toBeUndefined();
  });

  it('does not require a capability that was declared false', () => {
    expect(requirementsFrom({ vision: false }).required).toBeUndefined();
  });
});

describe('the compatibility matrix', () => {
  const models = [
    model({ vision: 'supported', tools: 'supported' }, { modelId: 'full', displayName: 'Full' }),
    model({ vision: 'unsupported', tools: 'supported' }, { modelId: 'text', displayName: 'Text Only' }),
    model({ vision: 'unknown', tools: 'supported' }, { modelId: 'maybe', displayName: 'Unprobed' }),
  ];

  it('partitions into included and excluded', () => {
    const m = buildCompatibilityMatrix(models, NEEDS_VISION);
    expect(m.included.map((e) => e.modelId)).toEqual(['full']);
    expect(m.excluded.map((e) => e.modelId).sort()).toEqual(['maybe', 'text']);
  });

  it('keeps exclusions as data rather than dropping them', () => {
    // A skipped model that appears nowhere is indistinguishable from one
    // nobody selected.
    const m = buildCompatibilityMatrix(models, NEEDS_VISION);
    const text = m.excluded.find((e) => e.modelId === 'text');
    expect(text?.decision.missing).toEqual(['vision']);
    expect(text?.decision.reason).toContain('Text Only');
  });

  it('reports flagged models separately under include_flagged', () => {
    const m = buildCompatibilityMatrix(models, NEEDS_VISION, 'include_flagged');
    expect(m.included.map((e) => e.modelId).sort()).toEqual(['full', 'maybe']);
    expect(m.flagged.map((e) => e.modelId)).toEqual(['maybe']);
  });

  it('flagged is a subset of included, never of excluded', () => {
    const m = buildCompatibilityMatrix(models, NEEDS_VISION, 'include_flagged');
    const includedIds = new Set(m.included.map((e) => e.modelId));
    for (const f of m.flagged) expect(includedIds.has(f.modelId)).toBe(true);
  });

  it('handles an empty model set', () => {
    const m = buildCompatibilityMatrix([], NEEDS_VISION);
    expect(m.included).toEqual([]);
    expect(m.excluded).toEqual([]);
  });

  it('includes everything when the benchmark needs nothing', () => {
    const m = buildCompatibilityMatrix(models, {});
    expect(m.included).toHaveLength(3);
  });
});
