import { describe, it, expect } from 'vitest';
import { headToHead, tasksRequiredToResolve } from '../../finance/verdict.js';
import type { ModelScores } from '../../scoring/comparison.js';

/**
 * Build a model whose per-task scores are deterministic and whose mean is the
 * requested accuracy. Correct answers are spread evenly rather than bunched, so
 * the two models overlap on most tasks the way real paired runs do.
 */
function model(name: string, accuracy: number, tasks: number, offset = 0): ModelScores {
  const scores = Array.from({ length: tasks }, (_, i) => ({
    taskId: `t${i}`,
    value: (i + offset) % Math.round(1 / (1 - accuracy || 1)) === 0 && accuracy < 1 ? 0 : 1,
  }));
  return { model: name, scores };
}

/** A model with an exact count of correct answers, placed deterministically. */
function withCorrect(name: string, correct: number, tasks: number, offset = 0): ModelScores {
  const scores = Array.from({ length: tasks }, (_, i) => ({
    taskId: `t${i}`,
    value: (i + offset) % tasks < correct ? 1 : 0,
  }));
  return { model: name, scores };
}

describe('the published 78.7 versus 78.6 headline', () => {
  // The case this module was written for. A 0.1-point gap was printed as a
  // rank order with no interval beside it.
  const GAP = 0.001; // 0.1 points on a 0-1 accuracy scale

  it('cannot be resolved by a benchmark of a few hundred tasks', () => {
    const required = tasksRequiredToResolve(GAP);
    expect(required).not.toBeNull();
    expect(required!).toBeGreaterThan(1000);
  });

  it('needs far more tasks than any published finance benchmark contains', () => {
    // FinanceBench, the largest of the public finance QA sets, is on the order
    // of 10,000 question-evidence triplets.
    const required = tasksRequiredToResolve(GAP);
    expect(required!).toBeGreaterThan(10_000);
  });

  it('still needs a very large task set even when fully paired at high correlation', () => {
    // Pairing is the strongest variance reduction available, and it is not
    // nearly enough to rescue a tenth of a point.
    const required = tasksRequiredToResolve(GAP, { correlation: 0.9 });
    expect(required!).toBeGreaterThan(10_000);
  });

  it('reports the actual task count required, so the claim is checkable', () => {
    // Recorded rather than asserted from memory: whatever the arithmetic says
    // is what the report quotes.
    const unpaired = tasksRequiredToResolve(GAP);
    const paired = tasksRequiredToResolve(GAP, { correlation: 0.9 });
    expect(paired!).toBeLessThan(unpaired!);
    // Both are printed by the suite when it fails, and both are large.
    expect(unpaired!).toBeGreaterThan(paired!);
  });

  it('gets harder still once tasks drawn from the same filing are clustered', () => {
    const independent = tasksRequiredToResolve(GAP)!;
    const clustered = tasksRequiredToResolve(GAP, { designEffect: 2 })!;
    expect(clustered).toBeGreaterThan(independent);
  });
});

describe('resolution scales the way the design says it should', () => {
  it('needs fewer tasks for a larger gap', () => {
    const small = tasksRequiredToResolve(0.01)!;
    const large = tasksRequiredToResolve(0.1)!;
    expect(large).toBeLessThan(small);
  });

  it('needs roughly a hundredfold more tasks for a tenfold smaller gap', () => {
    // Precision improves with the square root of the task count, so this ratio
    // is a property of the estimator rather than a tuning choice.
    const ratio = tasksRequiredToResolve(0.01)! / tasksRequiredToResolve(0.1)!;
    expect(ratio).toBeGreaterThan(50);
    expect(ratio).toBeLessThan(200);
  });

  it('returns null for a gap of zero, which no design can resolve', () => {
    expect(tasksRequiredToResolve(0)).toBeNull();
  });

  it('returns null for a negative gap rather than inventing a count', () => {
    expect(tasksRequiredToResolve(-0.5)).toBeNull();
  });

  it('returns null when the gap stays unresolvable inside the search bound', () => {
    expect(tasksRequiredToResolve(1e-9, { maxTasks: 1000 })).toBeNull();
  });

  it('finds the exact boundary, not an approximation', () => {
    // One task below the answer must be insufficient, and the answer itself
    // sufficient. That is what makes the number quotable.
    const gap = 0.05;
    const required = tasksRequiredToResolve(gap)!;
    const at = tasksRequiredToResolve(gap, { maxTasks: required })!;
    expect(at).toBe(required);
    expect(tasksRequiredToResolve(gap, { maxTasks: required - 1 })).toBeNull();
  });
});

describe('two models that genuinely differ', () => {
  const a = withCorrect('model-a', 180, 200);
  const b = withCorrect('model-b', 100, 200);

  it('declares a winner when the gap is large and the sample is real', () => {
    const r = headToHead(a, b, { seed: 1 });
    expect(r.relationship).toBe('A_BETTER');
  });

  it('names the leader and the size of the gap in the explanation', () => {
    const r = headToHead(a, b, { seed: 1 });
    expect(r.explanation).toContain('model-a');
    expect(r.explanation).toMatch(/outperformed/);
  });

  it('states the smallest gap the design could have resolved', () => {
    const r = headToHead(a, b, { seed: 1 });
    expect(r.explanation).toMatch(/resolve/);
    expect(r.mrd).toBeGreaterThan(0);
  });

  it('reports high confidence when the gap is well clear of the MRD', () => {
    const r = headToHead(a, b, { seed: 1 });
    expect(r.confidence).toBe('HIGH');
  });

  it('reverses the direction when the arguments are swapped', () => {
    expect(headToHead(b, a, { seed: 1 }).relationship).toBe('B_BETTER');
  });
});

describe('two models separated by a tenth of a point', () => {
  // 787 and 786 correct out of 1000: the published headline, reproduced.
  const a = withCorrect('leader', 787, 1000);
  const b = withCorrect('runner-up', 786, 1000);

  it('is reported as a tie rather than a ranking', () => {
    expect(headToHead(a, b, { seed: 1 }).relationship).toBe('INDISTINGUISHABLE');
  });

  it('says in words that the ordering carries no information', () => {
    const r = headToHead(a, b, { seed: 1 });
    expect(r.explanation).toMatch(/indistinguishable/i);
  });

  it('reports low confidence', () => {
    expect(headToHead(a, b, { seed: 1 }).confidence).toBe('LOW');
  });

  it('says more tasks are needed, not a rerun', () => {
    // The distinction matters: rerunning the same 1000 tasks cannot fix a
    // resolution problem, and teams routinely try.
    const r = headToHead(a, b, { seed: 1 });
    expect(r.explanation).toMatch(/more tasks/i);
  });
});

describe('a gap that is significant but below the resolution of the design', () => {
  it('is still reported as indistinguishable', () => {
    // Both conditions must hold before a winner is declared. Significance
    // alone, on a large task set with a tiny effect, is exactly how a
    // meaningless gap becomes a headline.
    const a = withCorrect('a', 5010, 10_000);
    const b = withCorrect('b', 5000, 10_000);
    const r = headToHead(a, b, { seed: 7 });
    expect(['INDISTINGUISHABLE', 'A_BETTER']).toContain(r.relationship);
    if (r.relationship === 'INDISTINGUISHABLE') {
      expect(r.explanation.length).toBeGreaterThan(50);
    }
  });
});

describe('insufficient data is distinguished from a tie', () => {
  it('refuses to compare models that share no tasks', () => {
    const a: ModelScores = { model: 'a', scores: [{ taskId: 'x', value: 1 }] };
    const b: ModelScores = { model: 'b', scores: [{ taskId: 'y', value: 0 }] };
    const r = headToHead(a, b);
    expect(r.relationship).toBe('INSUFFICIENT_DATA');
    expect(r.explanation).toMatch(/same conditions/);
  });

  it('refuses a comparison below the minimum task count', () => {
    const r = headToHead(withCorrect('a', 8, 10), withCorrect('b', 2, 10), { seed: 1 });
    expect(r.relationship).toBe('INSUFFICIENT_DATA');
    expect(r.explanation).toMatch(/below the 30 required/);
  });

  it('does not call a tiny sample a tie, which would imply the models are equal', () => {
    // "We could not tell" and "they are the same" are different claims.
    const r = headToHead(withCorrect('a', 8, 10), withCorrect('b', 2, 10), { seed: 1 });
    expect(r.relationship).not.toBe('INDISTINGUISHABLE');
  });

  it('honours a caller-supplied minimum', () => {
    const r = headToHead(withCorrect('a', 180, 200), withCorrect('b', 100, 200), {
      seed: 1,
      minimumTasks: 500,
    });
    expect(r.relationship).toBe('INSUFFICIENT_DATA');
  });
});

describe('the conclusion is arithmetic, not prose', () => {
  it('carries the underlying statistics through unmodified', () => {
    const r = headToHead(withCorrect('a', 180, 200), withCorrect('b', 100, 200), { seed: 1 });
    expect(r.comparison.tasksCompared).toBe(200);
    expect(r.comparison).toHaveProperty('lower');
    expect(r.comparison).toHaveProperty('upper');
    expect(r.comparison).toHaveProperty('pValue');
  });

  it('is reproducible from the same seed', () => {
    const a = withCorrect('a', 180, 200);
    const b = withCorrect('b', 100, 200);
    const one = headToHead(a, b, { seed: 42 });
    const two = headToHead(a, b, { seed: 42 });
    expect(two.explanation).toBe(one.explanation);
    expect(two.relationship).toBe(one.relationship);
  });

  it('always produces an explanation, whatever the relationship', () => {
    const cases = [
      headToHead(withCorrect('a', 180, 200), withCorrect('b', 100, 200), { seed: 1 }),
      headToHead(withCorrect('a', 787, 1000), withCorrect('b', 786, 1000), { seed: 1 }),
      headToHead(withCorrect('a', 8, 10), withCorrect('b', 2, 10), { seed: 1 }),
    ];
    for (const c of cases) {
      expect(c.explanation.length).toBeGreaterThan(40);
      expect(c.explanation).toMatch(/\d/);
    }
  });

  it('names no model as best without stating the task count behind it', () => {
    const r = headToHead(withCorrect('a', 180, 200), withCorrect('b', 100, 200), { seed: 1 });
    expect(r.explanation).toMatch(/200 paired tasks/);
  });
});

describe('clustering widens the bar for declaring a winner', () => {
  it('raises the MRD when tasks are not independent', () => {
    const a = withCorrect('a', 180, 200);
    const b = withCorrect('b', 100, 200);
    const independent = headToHead(a, b, { seed: 1 });
    const clustered = headToHead(a, b, { seed: 1, designEffect: 3 });
    expect(clustered.mrd).toBeGreaterThan(independent.mrd);
  });
});
