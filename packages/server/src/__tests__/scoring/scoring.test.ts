import { describe, expect, it } from 'vitest';

import {
  logChoose,
  passAtK,
  passPowK,
  gPassAtK,
  mGPassAtK,
  passAtKVariance,
  maxPassAtKVariance,
} from '../../scoring/estimators.js';
import { designEffect, requiredTasks, resolvingPower } from '../../scoring/mrd.js';
import {
  clopperPearsonInterval,
  clusterBootstrapInterval,
  clusteredStandardError,
  scoreInterval,
  type Observation,
} from '../../scoring/intervals.js';
import { holmAdjust, pairedComparison, rankModels, type ModelScores } from '../../scoring/comparison.js';
import { compositeScore } from '../../scoring/composite.js';

describe('estimators', () => {
  it('pass@k reduces to the success rate at k=1', () => {
    for (const [n, c] of [
      [10, 3],
      [32, 17],
      [7, 0],
      [7, 7],
    ]) {
      expect(passAtK(n!, c!, 1)).toBeCloseTo(c! / n!, 12);
    }
  });

  it('pass@k equals 1 - C(n-c,k)/C(n,k) for every n up to 25', () => {
    // The closed form the numerically stable product replaces. Checked
    // exhaustively at sizes where the factorials are still safe.
    const closedForm = (n: number, c: number, k: number) =>
      n - c < k ? 1 : 1 - Math.exp(logChoose(n - c, k) - logChoose(n, k));

    for (let n = 1; n <= 25; n++) {
      for (let c = 0; c <= n; c++) {
        for (let k = 1; k <= n; k++) {
          expect(passAtK(n, c, k)).toBeCloseTo(closedForm(n, c, k), 10);
        }
      }
    }
  });

  it('G-pass collapses to pass@k at tau -> 0 and pass^k at tau = 1', () => {
    for (let n = 5; n <= 20; n++) {
      for (let c = 0; c <= n; c++) {
        for (let k = 1; k <= Math.min(n, 6); k++) {
          expect(gPassAtK(n, c, k, 1e-12)).toBeCloseTo(passAtK(n, c, k), 9);
          expect(gPassAtK(n, c, k, 1)).toBeCloseTo(passPowK(n, c, k), 9);
        }
      }
    }
  });

  it('G-pass is non-increasing in tau', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 10; i++) {
      const value = gPassAtK(40, 25, 8, i / 10);
      expect(value).toBeLessThanOrEqual(previous + 1e-12);
      previous = value;
    }
  });

  it('mG-pass sits between pass^k and pass@k', () => {
    const mg = mGPassAtK(40, 25, 8);
    expect(mg).toBeGreaterThanOrEqual(passPowK(40, 25, 8) - 1e-12);
    expect(mg).toBeLessThanOrEqual(passAtK(40, 25, 8) + 1e-12);
  });

  it('separates capability from reliability', () => {
    // 30 of 40 attempts succeed. Over 10 attempts it will almost certainly
    // succeed at least once, and almost certainly not succeed every time.
    // A leaderboard reporting only the first calls this a 0.99 system.
    expect(passAtK(40, 30, 10)).toBeGreaterThan(0.99);
    expect(passPowK(40, 30, 10)).toBeLessThan(0.06);
  });

  it('variance matches p(1-p)/n at k=1 and vanishes at the boundaries', () => {
    for (const p of [0.1, 0.3, 0.5, 0.77]) {
      expect(passAtKVariance(32, 1, p)).toBeCloseTo((p * (1 - p)) / 32, 12);
    }
    expect(passAtKVariance(32, 4, 0)).toBe(0);
    expect(passAtKVariance(32, 4, 1)).toBe(0);
  });

  it('worst-case variance of pass@1 is 1/(4n) at p = 0.5', () => {
    const worst = maxPassAtKVariance(32, 1);
    expect(worst.variance).toBeCloseTo(1 / (4 * 32), 9);
    expect(worst.atP).toBeCloseTo(0.5, 3);
  });

  it('refuses a sample it cannot estimate from', () => {
    expect(() => passAtK(4, 2, 8)).toThrow(/exceeds/);
    expect(() => passAtK(10, 11, 2)).toThrow(/c must be/);
  });
});

describe('minimum resolvable difference', () => {
  it('shrinks as tasks grow', () => {
    const small = resolvingPower({ n: 32, k: 1, tasks: 30 });
    const large = resolvingPower({ n: 32, k: 1, tasks: 300 });
    expect(large.halfWidth).toBeLessThan(small.halfWidth);
    // Ten times the tasks buys sqrt(10) in precision, not ten.
    expect(small.halfWidth / large.halfWidth).toBeCloseTo(Math.sqrt(10), 1);
  });

  it('a difference is harder to resolve than a single score', () => {
    const r = resolvingPower({ n: 32, k: 1, tasks: 100 });
    expect(r.unpairedMrd).toBeGreaterThan(r.halfWidth);
    expect(r.unpairedMrd).toBeCloseTo(r.halfWidth * Math.SQRT2, 9);
  });

  it('pairing on a shared task set shrinks the resolvable difference', () => {
    const independent = resolvingPower({ n: 32, k: 1, tasks: 200 }, 0);
    const paired = resolvingPower({ n: 32, k: 1, tasks: 200 }, 0.75);
    expect(paired.pairedMrd).toBeLessThan(independent.pairedMrd);
    expect(paired.pairedMrd).toBeCloseTo(independent.pairedMrd * Math.sqrt(0.25), 9);
  });

  it('clustering costs effective sample size', () => {
    expect(designEffect([5, 5, 5, 5], 0.3)).toBeCloseTo(1 + 4 * 0.3, 12);
    expect(designEffect([5, 5, 5, 5], 0)).toBe(1);

    const clustered = resolvingPower({ n: 32, k: 1, tasks: 40, designEffect: 2.2 });
    expect(clustered.effectiveTasks).toBeCloseTo(40 / 2.2, 9);
    expect(clustered.halfWidth).toBeGreaterThan(
      resolvingPower({ n: 32, k: 1, tasks: 40 }).halfWidth,
    );
  });

  it('requiredTasks inverts the resolving power it was asked for', () => {
    const target = 0.05;
    const { tasks } = requiredTasks({ n: 32, k: 1, targetDifference: target });
    expect(resolvingPower({ n: 32, k: 1, tasks }).unpairedMrd).toBeLessThanOrEqual(target + 1e-9);
    // One task fewer should not have been enough.
    expect(resolvingPower({ n: 32, k: 1, tasks: tasks - 1 }).unpairedMrd).toBeGreaterThan(target);
  });
});

describe('intervals', () => {
  /** Independent binomial tail, for checking Clopper-Pearson against its definition. */
  const tail = (n: number, from: number, to: number, p: number) => {
    let total = 0;
    for (let j = from; j <= to; j++) {
      total += Math.exp(logChoose(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p));
    }
    return total;
  };

  it('Clopper-Pearson bounds satisfy their defining tail equations', () => {
    // The bounds are DEFINED as the p at which the relevant tail equals
    // alpha/2. Recomputing that tail at the returned bound is a genuine oracle,
    // not a restatement of the implementation.
    for (const [n, c] of [
      [20, 7],
      [40, 1],
      [100, 63],
      [30, 29],
    ]) {
      const ci = clopperPearsonInterval(c!, n!, 0.05);
      expect(tail(n!, c!, n!, ci.lower)).toBeCloseTo(0.025, 6);
      expect(tail(n!, 0, c!, ci.upper)).toBeCloseTo(0.025, 6);
      expect(ci.lower).toBeLessThanOrEqual(ci.estimate);
      expect(ci.upper).toBeGreaterThanOrEqual(ci.estimate);
    }
  });

  it('Clopper-Pearson handles the degenerate counts', () => {
    expect(clopperPearsonInterval(0, 20).lower).toBe(0);
    expect(clopperPearsonInterval(20, 20).upper).toBe(1);
    // Twenty clean runs are evidence of a low rate, not proof of zero.
    expect(clopperPearsonInterval(0, 20).upper).toBeGreaterThan(0.1);
  });

  it('clustered standard errors exceed naive ones when tasks correlate', () => {
    // Two clusters, each internally consistent and mutually opposed: the
    // textbook case where independence badly understates the error.
    const correlated: Observation[] = [
      ...Array.from({ length: 10 }, () => ({ value: 1, cluster: 'repo-a' })),
      ...Array.from({ length: 10 }, () => ({ value: 0, cluster: 'repo-b' })),
    ];
    const { standardError, naiveStandardError } = clusteredStandardError(correlated);
    expect(standardError).toBeGreaterThan(naiveStandardError * 2);
  });

  it('reports the standard error as unidentified from a single cluster', () => {
    const single: Observation[] = Array.from({ length: 10 }, () => ({
      value: 1,
      cluster: 'only',
    }));
    expect(clusteredStandardError(single).standardError).toBe(Number.POSITIVE_INFINITY);
  });

  it('the bootstrap is deterministic under a fixed seed', () => {
    const data: Observation[] = Array.from({ length: 40 }, (_, i) => ({
      value: i % 3 === 0 ? 1 : 0,
      cluster: `c${i % 8}`,
    }));
    const a = clusterBootstrapInterval(data, { seed: 7, resamples: 2000 });
    const b = clusterBootstrapInterval(data, { seed: 7, resamples: 2000 });
    expect(a).toEqual(b);
  });

  it('picks the exact method for unclustered binary data', () => {
    const binary: Observation[] = Array.from({ length: 40 }, (_, i) => ({ value: i < 25 ? 1 : 0 }));
    const interval = scoreInterval(binary);
    expect(interval.method).toBe('clopper-pearson');
    expect(interval.rationale).toMatch(/no normal approximation/);
  });

  it('refuses the CLT below the sample size where it is calibrated', () => {
    const small: Observation[] = Array.from({ length: 40 }, (_, i) => ({
      value: (i % 5) / 4,
      cluster: `c${i % 8}`,
    }));
    expect(scoreInterval(small).method).toBe('cluster-bootstrap');
  });

  it('uses clustered CLT once there is enough data for it', () => {
    const large: Observation[] = Array.from({ length: 400 }, (_, i) => ({
      value: (i % 5) / 4,
      cluster: `c${i % 40}`,
    }));
    const interval = scoreInterval(large);
    expect(interval.method).toBe('clustered-clt');
    expect(interval.clusters).toBe(40);
  });
});

describe('comparison', () => {
  it('Holm adjustment is monotone, never below the raw value, and capped', () => {
    const raw = [0.001, 0.008, 0.039, 0.041, 0.9];
    const adjusted = holmAdjust(raw);

    adjusted.forEach((a, i) => {
      expect(a).toBeGreaterThanOrEqual(raw[i]!);
      expect(a).toBeLessThanOrEqual(1);
    });
    // Order is preserved, so a step-down never re-ranks the comparisons.
    const sortedRaw = [...raw].sort((a, b) => a - b);
    const sortedAdjusted = sortedRaw.map((p) => adjusted[raw.indexOf(p)]!);
    for (let i = 1; i < sortedAdjusted.length; i++) {
      expect(sortedAdjusted[i]!).toBeGreaterThanOrEqual(sortedAdjusted[i - 1]!);
    }
    // Smallest p against 5 comparisons: 5 * 0.001.
    expect(adjusted[0]).toBeCloseTo(0.005, 12);
  });

  it('Holm is no more conservative than Bonferroni', () => {
    const raw = [0.01, 0.02, 0.03, 0.04];
    const holm = holmAdjust(raw);
    holm.forEach((h, i) => {
      expect(h).toBeLessThanOrEqual(Math.min(1, raw.length * raw[i]!) + 1e-12);
    });
  });

  it('finds no difference between a model and itself', () => {
    const scores = Array.from({ length: 60 }, (_, i) => ({
      taskId: `t${i}`,
      value: i % 3 === 0 ? 1 : 0,
      cluster: `c${i % 10}`,
    }));
    const result = pairedComparison({ model: 'a', scores }, { model: 'b', scores });
    expect(result.difference).toBe(0);
    expect(result.correlation).toBeCloseTo(1, 9);
    expect(result.pValue).toBe(1);
  });

  it('only compares tasks both models attempted', () => {
    const a: ModelScores = {
      model: 'a',
      scores: [
        { taskId: 't1', value: 1 },
        { taskId: 't2', value: 1 },
        { taskId: 'only-a', value: 1 },
      ],
    };
    const b: ModelScores = {
      model: 'b',
      scores: [
        { taskId: 't1', value: 0 },
        { taskId: 't2', value: 0 },
      ],
    };
    expect(pairedComparison(a, b).tasksCompared).toBe(2);
  });

  it('puts indistinguishable models in one tier and does not order them', () => {
    // Three models with essentially identical per-task behaviour.
    const make = (model: string, offset: number): ModelScores => ({
      model,
      scores: Array.from({ length: 80 }, (_, i) => ({
        taskId: `t${i}`,
        value: (i + offset) % 4 === 0 ? 1 : 0,
        cluster: `c${i % 10}`,
      })),
    });
    const ranking = rankModels([make('a', 0), make('b', 1), make('c', 2)]);
    expect(ranking.tiers).toHaveLength(1);
    expect(ranking.tiers[0]!.models).toHaveLength(3);
    expect(ranking.methodology).toMatch(/not transitive/);
  });

  it('separates models that genuinely differ', () => {
    const strong: ModelScores = {
      model: 'strong',
      scores: Array.from({ length: 120 }, (_, i) => ({
        taskId: `t${i}`,
        value: i % 10 === 0 ? 0 : 1,
        cluster: `c${i % 12}`,
      })),
    };
    const weak: ModelScores = {
      model: 'weak',
      scores: Array.from({ length: 120 }, (_, i) => ({
        taskId: `t${i}`,
        value: i % 10 === 0 ? 1 : 0,
        cluster: `c${i % 12}`,
      })),
    };
    const ranking = rankModels([weak, strong]);
    expect(ranking.tiers).toHaveLength(2);
    expect(ranking.tiers[0]!.models).toEqual(['strong']);
    expect(ranking.comparisons[0]!.significant).toBe(true);
  });

  it('corrects across the whole family of comparisons', () => {
    const models = Array.from({ length: 6 }, (_, m) => ({
      model: `m${m}`,
      scores: Array.from({ length: 50 }, (_, i) => ({
        taskId: `t${i}`,
        value: (i * 7 + m) % 5 === 0 ? 1 : 0,
        cluster: `c${i % 8}`,
      })),
    }));
    const ranking = rankModels(models);
    // 6 models -> 15 unordered pairs, all corrected together.
    expect(ranking.comparisons).toHaveLength(15);
    ranking.comparisons.forEach((c) => {
      expect(c.adjustedPValue).toBeGreaterThanOrEqual(c.pValue);
    });
  });
});

describe('composite score', () => {
  const base = {
    estimate: 0.8,
    lower: 0.75,
    upper: 0.85,
    method: 'clopper-pearson' as const,
    n: 100,
    clusters: 100,
    varianceInflation: null,
    rationale: 'test',
  };

  it('applies each factor and keeps it visible', () => {
    const result = compositeScore(base, {
      contaminationDiscount: 0.1,
      gamingRate: 0.05,
      verifierConfidence: 0.9,
    });
    expect(result.score).toBeCloseTo(0.8 * 0.9 * 0.95 * 0.9, 12);
    expect(result.applied.map((a) => a.factor)).toEqual(['contamination', 'gaming', 'verifier']);
    expect(result.provisional).toBe(false);
  });

  it('marks an unassessed factor provisional instead of treating it as clean', () => {
    const result = compositeScore(base, {
      contaminationDiscount: null,
      gamingRate: 0.05,
      verifierConfidence: 0.9,
    });
    expect(result.provisional).toBe(true);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]!.reason).toMatch(/unknown rather than absent/);
    // The score is not silently discounted by a factor nobody measured.
    expect(result.score).toBeCloseTo(0.8 * 0.95 * 0.9, 12);
  });

  it('a weak verifier widens the interval as well as lowering the score', () => {
    const strong = compositeScore(base, {
      contaminationDiscount: 0,
      gamingRate: 0,
      verifierConfidence: 1,
    });
    const weak = compositeScore(base, {
      contaminationDiscount: 0,
      gamingRate: 0,
      verifierConfidence: 0.5,
    });
    const widthOf = (r: { lower: number; upper: number }) => r.upper - r.lower;
    expect(weak.score).toBeLessThan(strong.score);
    // Scaled by 0.5 then widened 1.5x, so the width is 0.75 of the original --
    // narrower in absolute terms but much wider relative to a halved score.
    expect(widthOf(weak) / weak.score).toBeGreaterThan(widthOf(strong) / strong.score);
  });

  it('rejects a factor outside [0,1]', () => {
    expect(() =>
      compositeScore(base, {
        contaminationDiscount: 1.5,
        gamingRate: 0,
        verifierConfidence: 1,
      }),
    ).toThrow(/must be in/);
  });

  it('records a derivation anyone can recompute', () => {
    const result = compositeScore(base, {
      contaminationDiscount: 0.1,
      gamingRate: null,
      verifierConfidence: 0.8,
    });
    expect(result.derivation).toMatch(/base 0\.8000/);
    expect(result.derivation).toMatch(/PROVISIONAL: gaming unassessed/);
  });
});
