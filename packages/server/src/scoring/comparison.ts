/**
 * Comparing models, and refusing to rank what cannot be ranked.
 *
 * Three things here, in order of how much they change a published leaderboard.
 *
 * PAIRED analysis. Both models run the identical task set, so the comparison is
 * over per-task DIFFERENCES rather than over two independent means. Hard tasks
 * are hard for everyone, which means scores correlate, which means the shared
 * component of the error cancels in the difference. This is the cheapest
 * variance reduction in the entire pipeline and it costs nothing but bookkeeping.
 *
 * HOLM correction. A 50-model leaderboard makes 1,225 pairwise comparisons. At
 * alpha = 0.05 roughly 61 of them come back "significant" from chance alone. An
 * uncorrected leaderboard of any size therefore contains manufactured wins, and
 * the bigger it gets the more it contains. Holm controls the family-wise error
 * rate, is uniformly more powerful than Bonferroni, and assumes nothing about
 * how the comparisons are correlated -- which matters, because these are
 * heavily correlated and no simple assumption about that would be true.
 *
 * TIERS instead of positions. Differences below the resolving power are noise,
 * so publishing places 1 through 50 asserts 49 orderings the data cannot
 * support. Grouping into bands of statistically indistinguishable models is
 * more honest, more useful, and defensible in an audit in a way a false ordinal
 * is not.
 */

import { clusterBootstrapInterval, type Observation } from './intervals.js';

export interface TaskScore {
  taskId: string;
  value: number;
  /** Correlation group: repository, project, scenario family, author. */
  cluster?: string;
}

export interface ModelScores {
  model: string;
  scores: readonly TaskScore[];
}

export interface PairedComparison {
  a: string;
  b: string;
  /** Mean of (a - b) over the shared task set. Positive means a scored higher. */
  difference: number;
  lower: number;
  upper: number;
  /** Two-sided bootstrap p-value, before correction. */
  pValue: number;
  /** After Holm correction across the whole family. Filled in by `rankModels`. */
  adjustedPValue?: number;
  tasksCompared: number;
  /**
   * Correlation between the two models' per-task scores. High values are why
   * pairing helps; near zero means pairing bought nothing and the task set may
   * not be discriminating.
   */
  correlation: number;
  significant?: boolean;
}

/**
 * Compare two models on the tasks they both attempted.
 *
 * Tasks only one model ran are dropped rather than imputed. An imputed score is
 * a made-up observation, and made-up observations narrow intervals.
 */
export function pairedComparison(
  a: ModelScores,
  b: ModelScores,
  options: { alpha?: number; seed?: number; resamples?: number } = {},
): PairedComparison {
  const { alpha = 0.05, seed = 0x5eed, resamples = 10_000 } = options;

  const bByTask = new Map(b.scores.map((s) => [s.taskId, s]));
  const differences: Observation[] = [];
  const aValues: number[] = [];
  const bValues: number[] = [];

  for (const scoreA of a.scores) {
    const scoreB = bByTask.get(scoreA.taskId);
    if (!scoreB) continue;
    differences.push({ value: scoreA.value - scoreB.value, cluster: scoreA.cluster });
    aValues.push(scoreA.value);
    bValues.push(scoreB.value);
  }

  if (differences.length === 0) {
    return {
      a: a.model,
      b: b.model,
      difference: 0,
      lower: 0,
      upper: 0,
      pValue: 1,
      tasksCompared: 0,
      correlation: 0,
      significant: false,
    };
  }

  const boot = clusterBootstrapInterval(differences, { alpha, seed, resamples });
  const pValue = bootstrapPValue(differences, { seed, resamples });

  return {
    a: a.model,
    b: b.model,
    difference: boot.estimate,
    lower: boot.lower,
    upper: boot.upper,
    pValue,
    tasksCompared: differences.length,
    correlation: pearson(aValues, bValues),
  };
}

/**
 * Two-sided bootstrap p-value for "the mean difference is zero".
 *
 * Taken as twice the smaller tail of the resampled difference distribution,
 * floored at 1/resamples: with 10,000 resamples the smallest honest claim is
 * p < 0.0001, and reporting p = 0 would assert a precision the resampling
 * cannot deliver.
 */
function bootstrapPValue(
  differences: readonly Observation[],
  options: { seed: number; resamples: number },
): number {
  const { seed, resamples } = options;
  // Reuse the same resampling machinery, then read the sign distribution off
  // the percentile ladder by bisecting for the quantile of zero.
  const groups = new Map<string, number[]>();
  differences.forEach((d, i) => {
    const key = d.cluster ?? `__singleton_${i}`;
    const existing = groups.get(key);
    if (existing) existing.push(d.value);
    else groups.set(key, [d.value]);
  });
  const clusters = [...groups.values()];
  if (clusters.length < 2) return 1;

  const rng = mulberry32(seed);
  let atOrBelowZero = 0;
  let atOrAboveZero = 0;

  for (let r = 0; r < resamples; r++) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < clusters.length; i++) {
      const picked = clusters[Math.floor(rng() * clusters.length)]!;
      for (const v of picked) {
        total += v;
        count++;
      }
    }
    const m = count === 0 ? 0 : total / count;
    if (m <= 0) atOrBelowZero++;
    if (m >= 0) atOrAboveZero++;
  }

  const smallerTail = Math.min(atOrBelowZero, atOrAboveZero) / resamples;
  return Math.min(1, Math.max(1 / resamples, 2 * smallerTail));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  if (n < 2) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Holm-Bonferroni step-down correction.
 *
 * Sort p-values ascending; multiply the i-th by (m - i + 1); enforce
 * monotonicity so an adjusted value never falls below the one before it; cap at
 * 1. Controls the family-wise error rate under arbitrary dependence, which is
 * the only assumption safe to make about leaderboard comparisons.
 *
 * Returns adjusted values in the caller's original order.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];

  const indexed = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);

  const adjusted = new Array<number>(m);
  let running = 0;
  indexed.forEach((entry, i) => {
    const scaled = (m - i) * entry.p;
    running = Math.max(running, scaled);
    adjusted[entry.index] = Math.min(1, running);
  });

  return adjusted;
}

export interface Tier {
  rank: number;
  models: string[];
  /** Range spanned by the tier's point estimates. */
  low: number;
  high: number;
}

export interface Ranking {
  tiers: Tier[];
  comparisons: PairedComparison[];
  /** Point estimate per model, for display alongside the tier. */
  estimates: Array<{ model: string; estimate: number }>;
  /** Stated so a reader knows what the tiering is doing. */
  methodology: string;
}

/**
 * Group models into tiers of statistically indistinguishable performance.
 *
 * Models are sorted by point estimate, and each is admitted to the current tier
 * if its Holm-adjusted comparison against that tier's LEADER is not
 * significant. When one is significantly worse than the leader, a new tier
 * opens with it.
 *
 * The choice of the leader as reference is deliberate, and it is a choice
 * rather than a derivation: "not significantly different" is NOT transitive.
 * A can tie B and B can tie C while A beats C. Any tiering has to break that
 * somewhere, and comparing to the leader is the option that never places a
 * model in a tier above one it demonstrably lost to. Chaining to the previous
 * member instead would let a tier drift arbitrarily far from its top.
 *
 * This is stated in `methodology` on every result, because a tiering whose rule
 * is hidden is just an ordinal ranking with extra steps.
 */
export function rankModels(
  models: readonly ModelScores[],
  options: { alpha?: number; seed?: number; resamples?: number } = {},
): Ranking {
  const { alpha = 0.05, seed, resamples } = options;

  const estimates = models
    .map((m) => ({
      model: m.model,
      estimate:
        m.scores.length === 0
          ? 0
          : m.scores.reduce((a, s) => a + s.value, 0) / m.scores.length,
    }))
    .sort((a, b) => b.estimate - a.estimate);

  const byName = new Map(models.map((m) => [m.model, m]));

  // Every unordered pair, so the correction is over the true family size.
  const comparisons: PairedComparison[] = [];
  for (let i = 0; i < estimates.length; i++) {
    for (let j = i + 1; j < estimates.length; j++) {
      comparisons.push(
        pairedComparison(byName.get(estimates[i]!.model)!, byName.get(estimates[j]!.model)!, {
          alpha,
          seed,
          resamples,
        }),
      );
    }
  }

  const adjusted = holmAdjust(comparisons.map((c) => c.pValue));
  comparisons.forEach((c, i) => {
    c.adjustedPValue = adjusted[i]!;
    c.significant = adjusted[i]! < alpha;
  });

  const significantAgainstLeader = (leader: string, candidate: string): boolean =>
    comparisons.some(
      (c) =>
        c.significant === true &&
        ((c.a === leader && c.b === candidate) || (c.a === candidate && c.b === leader)),
    );

  const tiers: Tier[] = [];
  let current: string[] = [];
  let leader: string | null = null;

  for (const { model } of estimates) {
    if (leader === null) {
      leader = model;
      current = [model];
      continue;
    }
    if (significantAgainstLeader(leader, model)) {
      tiers.push(buildTier(tiers.length + 1, current, estimates));
      leader = model;
      current = [model];
    } else {
      current.push(model);
    }
  }
  if (current.length > 0) tiers.push(buildTier(tiers.length + 1, current, estimates));

  return {
    tiers,
    comparisons,
    estimates,
    methodology:
      `Models are grouped into tiers of statistically indistinguishable performance. ` +
      `Comparisons are paired on the shared task set, intervals come from resampling ` +
      `clusters, and all ${comparisons.length} pairwise p-values are Holm-corrected at ` +
      `alpha = ${alpha}. A model joins the current tier unless it is significantly worse ` +
      `than that tier's highest-scoring member. Note that statistical indistinguishability ` +
      `is not transitive, so tier boundaries depend on this stated rule; models within a ` +
      `tier are not ordered, because the data does not order them.`,
  };
}

function buildTier(
  rank: number,
  models: readonly string[],
  estimates: ReadonlyArray<{ model: string; estimate: number }>,
): Tier {
  const values = models.map((m) => estimates.find((e) => e.model === m)!.estimate);
  return {
    rank,
    models: [...models],
    low: Math.min(...values),
    high: Math.max(...values),
  };
}
