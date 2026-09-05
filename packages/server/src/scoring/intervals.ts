/**
 * Confidence intervals that survive contact with an agent benchmark.
 *
 * Two errors dominate published agent evaluation, and both make intervals too
 * narrow -- which is the dangerous direction, because a too-narrow interval
 * manufactures significance that is not there.
 *
 *   Independence.  Tasks from the same repository, CVE project, scenario family
 *                  or author are correlated. Treating them as independent
 *                  understates the standard error by up to 3x (Miller,
 *                  arXiv 2411.00640), so a typical published interval is about
 *                  a third of its true width.
 *
 *   The CLT.       Below a few hundred datapoints the normal approximation is
 *                  miscalibrated (Bowyer et al., arXiv 2503.01747). That range
 *                  covers almost every agent benchmark in use: Cybench has 40
 *                  tasks, AIME 30, Terminal-Bench 89, HumanEval 164.
 *
 * So the method is selected from the data rather than fixed. Three are
 * implemented, each correct in a different regime, and the report always says
 * which one produced the number.
 *
 *   clustered-clt      M large, many clusters. Liang-Zeger sandwich.
 *   cluster-bootstrap  small M, or clustered continuous scores. Resamples
 *                      CLUSTERS, not observations -- resampling observations
 *                      would destroy the correlation the interval exists to
 *                      account for.
 *   clopper-pearson    a single binary proportion with no clustering. Exact,
 *                      by inverting the binomial tail.
 */

import { logChoose } from './estimators.js';

const Z95 = 1.959963984540054;

/** One task's score, and the group it is correlated within. */
export interface Observation {
  value: number;
  /** Repository, project, scenario family, author. Absent means its own cluster. */
  cluster?: string;
}

export type IntervalMethod = 'clustered-clt' | 'cluster-bootstrap' | 'clopper-pearson';

export interface Interval {
  estimate: number;
  lower: number;
  upper: number;
  method: IntervalMethod;
  /** Observations behind the estimate. */
  n: number;
  /** Distinct clusters. Equal to n when nothing was clustered. */
  clusters: number;
  /**
   * Ratio of the clustered standard error to the naive one. Above 1 means
   * independence would have overstated precision by this factor -- the number
   * that quantifies how wrong the usual approach would have been here.
   */
  varianceInflation: number | null;
  /** Why this method was chosen, for the methodology page. */
  rationale: string;
}

function groupByCluster(observations: readonly Observation[]): number[][] {
  const groups = new Map<string, number[]>();
  observations.forEach((o, i) => {
    const key = o.cluster ?? `__singleton_${i}`;
    const existing = groups.get(key);
    if (existing) existing.push(o.value);
    else groups.set(key, [o.value]);
  });
  return [...groups.values()];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Liang-Zeger clustered standard error of the mean.
 *
 *     Var(xbar) = (G / (G-1)) * sum_g ( sum_{i in g} (x_i - xbar) )^2 / M^2
 *
 * The inner sum is over a whole cluster BEFORE squaring. That is the entire
 * difference from the independent formula, and the entire point: errors that
 * move together within a cluster add up instead of cancelling.
 *
 * The G/(G-1) factor is the standard CR1 small-cluster correction. It matters:
 * with 8 clusters it inflates the variance by 14%, and agent benchmarks
 * routinely have single-digit cluster counts.
 */
export function clusteredStandardError(observations: readonly Observation[]): {
  standardError: number;
  naiveStandardError: number;
  clusters: number;
} {
  const values = observations.map((o) => o.value);
  const m = values.length;
  const groups = groupByCluster(observations);
  const g = groups.length;
  const xbar = mean(values);

  const naiveVariance =
    m < 2 ? 0 : values.reduce((acc, v) => acc + (v - xbar) ** 2, 0) / (m * (m - 1));

  if (g < 2) {
    // One cluster carries no information about between-cluster variation. The
    // honest answer is that the standard error is not identified, not zero.
    return {
      standardError: Number.POSITIVE_INFINITY,
      naiveStandardError: Math.sqrt(naiveVariance),
      clusters: g,
    };
  }

  let sumOfSquaredClusterSums = 0;
  for (const group of groups) {
    const clusterSum = group.reduce((acc, v) => acc + (v - xbar), 0);
    sumOfSquaredClusterSums += clusterSum ** 2;
  }

  const variance = (g / (g - 1)) * (sumOfSquaredClusterSums / (m * m));
  return {
    standardError: Math.sqrt(variance),
    naiveStandardError: Math.sqrt(naiveVariance),
    clusters: g,
  };
}

/**
 * Percentile interval from resampling CLUSTERS with replacement.
 *
 * Correct where the CLT is not: small M, skewed scores, bounded outcomes
 * piling up at 0 or 1. It makes no distributional assumption and no large-
 * sample appeal, at the cost of being stochastic -- so the RNG is seeded and
 * the seed goes in the report, because an interval that changes between two
 * runs of the same analysis is not evidence.
 */
export function clusterBootstrapInterval(
  observations: readonly Observation[],
  options: { resamples?: number; seed?: number; alpha?: number } = {},
): { estimate: number; lower: number; upper: number; clusters: number } {
  const { resamples = 10_000, seed = 0x5eed, alpha = 0.05 } = options;
  const groups = groupByCluster(observations);
  const estimate = mean(observations.map((o) => o.value));

  if (groups.length < 2) {
    return { estimate, lower: 0, upper: 1, clusters: groups.length };
  }

  const rng = mulberry32(seed);
  const means: number[] = [];

  for (let r = 0; r < resamples; r++) {
    let total = 0;
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      const picked = groups[Math.floor(rng() * groups.length)]!;
      for (const v of picked) {
        total += v;
        count++;
      }
    }
    means.push(count === 0 ? 0 : total / count);
  }

  means.sort((a, b) => a - b);
  const lowerIndex = Math.floor((alpha / 2) * (means.length - 1));
  const upperIndex = Math.ceil((1 - alpha / 2) * (means.length - 1));
  return {
    estimate,
    lower: means[lowerIndex]!,
    upper: means[upperIndex]!,
    clusters: groups.length,
  };
}

/** Deterministic PRNG. Seeded so an interval is reproducible from the report. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** P(X >= c) for X ~ Binomial(n, p), summed in log space. */
function binomialUpperTail(n: number, c: number, p: number): number {
  if (c <= 0) return 1;
  if (c > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let total = 0;
  for (let j = c; j <= n; j++) {
    total += Math.exp(logChoose(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p));
  }
  return Math.min(1, Math.max(0, total));
}

/** P(X <= c) for X ~ Binomial(n, p). */
function binomialLowerTail(n: number, c: number, p: number): number {
  if (c >= n) return 1;
  if (c < 0) return 0;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let total = 0;
  for (let j = 0; j <= c; j++) {
    total += Math.exp(logChoose(n, j) + j * Math.log(p) + (n - j) * Math.log(1 - p));
  }
  return Math.min(1, Math.max(0, total));
}

/**
 * Clopper-Pearson exact interval for a binomial proportion.
 *
 * Defined by inverting the binomial tail directly: the lower bound is the p at
 * which observing c or more successes has probability alpha/2, and the upper
 * bound the p at which observing c or fewer does.
 *
 * Implemented by bisection on those tails rather than through an incomplete
 * beta function. The two are mathematically identical, but the tail sums are
 * computed from `logChoose`, which is already exhaustively tested -- so this
 * interval inherits that test coverage instead of depending on a fresh
 * numerical routine whose failures would be silent.
 *
 * Conservative by construction: actual coverage is at least 95%, never less.
 * For a compliance artifact that is the correct direction to err.
 */
export function clopperPearsonInterval(
  successes: number,
  trials: number,
  alpha = 0.05,
): { estimate: number; lower: number; upper: number } {
  if (!Number.isInteger(trials) || trials <= 0) {
    throw new RangeError(`trials must be a positive integer, got ${trials}`);
  }
  if (!Number.isInteger(successes) || successes < 0 || successes > trials) {
    throw new RangeError(`successes must be an integer in [0, ${trials}], got ${successes}`);
  }

  const estimate = successes / trials;
  const half = alpha / 2;

  const bisect = (f: (p: number) => number, increasing: boolean): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const value = f(mid);
      if (increasing ? value < half : value > half) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  // Zero successes admits p = 0; all successes admits p = 1. Bisection would
  // converge to those anyway, but stating them avoids 200 wasted iterations
  // and makes the boundary behaviour explicit.
  const lower =
    successes === 0 ? 0 : bisect((p) => binomialUpperTail(trials, successes, p), true);
  const upper =
    successes === trials ? 1 : bisect((p) => binomialLowerTail(trials, successes, p), false);

  return { estimate, lower, upper };
}

/**
 * Compute an interval, choosing the method from the shape of the data.
 *
 * The thresholds follow the cited literature: the CLT is trusted above roughly
 * 300 observations, and clustered inference needs enough clusters for the
 * between-cluster variance to be estimable at all -- 30 is the conventional
 * floor, and below it the sandwich estimator is itself unreliable.
 *
 * The chosen method is returned, not hidden. A reader who prefers a different
 * one can see which was used and why.
 */
export function scoreInterval(
  observations: readonly Observation[],
  options: {
    /** Set when every value is 0 or 1 and nothing is clustered. */
    binary?: boolean;
    alpha?: number;
    seed?: number;
    resamples?: number;
  } = {},
): Interval {
  const { binary = false, alpha = 0.05, seed, resamples } = options;
  const n = observations.length;

  if (n === 0) {
    return {
      estimate: 0,
      lower: 0,
      upper: 0,
      method: 'cluster-bootstrap',
      n: 0,
      clusters: 0,
      varianceInflation: null,
      rationale: 'No observations.',
    };
  }

  const { standardError, naiveStandardError, clusters } = clusteredStandardError(observations);
  const inflation =
    naiveStandardError > 0 && Number.isFinite(standardError)
      ? standardError / naiveStandardError
      : null;

  const values = observations.map((o) => o.value);
  const estimate = mean(values);
  const isBinaryData = values.every((v) => v === 0 || v === 1);

  // Exact, and available only when the data really is an unclustered sequence
  // of Bernoulli trials. Preferred there because it needs no approximation.
  if ((binary || isBinaryData) && clusters === n) {
    const successes = values.reduce((a, b) => a + b, 0);
    const exact = clopperPearsonInterval(successes, n, alpha);
    return {
      ...exact,
      method: 'clopper-pearson',
      n,
      clusters,
      varianceInflation: inflation,
      rationale:
        `Binary outcomes with no clustering (${n} independent tasks). Exact ` +
        'inversion of the binomial tail; no normal approximation involved.',
    };
  }

  if (n >= 300 && clusters >= 30) {
    const half = Z95 * standardError;
    return {
      estimate,
      lower: Math.max(0, estimate - half),
      upper: Math.min(1, estimate + half),
      method: 'clustered-clt',
      n,
      clusters,
      varianceInflation: inflation,
      rationale:
        `${n} observations across ${clusters} clusters is enough for the normal ` +
        'approximation. Standard error is the Liang-Zeger sandwich, so ' +
        'within-cluster correlation is carried' +
        (inflation ? `; it widened the interval by ${inflation.toFixed(2)}x.` : '.'),
    };
  }

  const boot = clusterBootstrapInterval(observations, { alpha, seed, resamples });
  return {
    estimate: boot.estimate,
    lower: boot.lower,
    upper: boot.upper,
    method: 'cluster-bootstrap',
    n,
    clusters,
    varianceInflation: inflation,
    rationale:
      `${n} observations across ${clusters} clusters is below the threshold where ` +
      'the CLT is calibrated for this kind of data (Bowyer et al., ' +
      'arXiv 2503.01747). Clusters are resampled with replacement instead, which ' +
      'assumes nothing about the score distribution.',
  };
}
