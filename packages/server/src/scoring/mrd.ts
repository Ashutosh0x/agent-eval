/**
 * Minimum resolvable difference: what a benchmark can actually tell apart.
 *
 * A leaderboard that ranks two models 2 points apart on a benchmark whose
 * resolving power is 8 points has not ranked them. It has published the
 * measurement error in descending order.
 *
 * The MRD is one line of arithmetic over the estimator variance, and no public
 * leaderboard publishes it. It is the cheapest possible way to make the point
 * that most reported agent rankings are not supported by their own sample
 * sizes -- and unlike an argument, it is checkable.
 *
 * Three quantities here, deliberately not conflated, because the field
 * routinely reports the first and reasons with the second:
 *
 *   resolvingPower              half-width of one model's confidence interval
 *   minimumResolvableDifference smallest gap between TWO models that clears
 *                               significance -- larger, because a difference
 *                               carries both models' uncertainty
 *   requiredTasks               how many tasks would be needed for a target
 *
 * The paired form matters. Evaluating both models on the identical task set
 * makes their errors correlate, and that correlation is the single cheapest
 * variance reduction available in this whole pipeline: at rho = 0.7 the
 * required task count drops by more than half for the same claim.
 */

import { maxPassAtKVariance } from './estimators.js';

/** 97.5th percentile of the standard normal. */
const Z95 = 1.959963984540054;

export interface DesignInput {
  /** Samples drawn per task. */
  n: number;
  /** Attempts the score is reported over. */
  k: number;
  /** Number of tasks in the benchmark. */
  tasks: number;
  /**
   * Variance inflation from clustering, from `designEffect`.
   *
   * Tasks drawn from the same repository, CVE project, scenario family or
   * author are not independent, and treating them as independent is the single
   * most common error in the field: cluster-adjusted standard errors run up to
   * 3x the naive ones (Miller, arXiv 2411.00640), so most published intervals
   * are about a third of their true width.
   *
   * Defaults to 1.0 -- no clustering -- which is an assumption, not a fact, and
   * is almost always wrong for agent benchmarks.
   */
  designEffect?: number;
  /** Two-sided confidence. Defaults to 95%. */
  z?: number;
}

export interface ResolvingPower {
  /** Half-width of a single model's interval, in score points. */
  halfWidth: number;
  /** Smallest detectable gap between two models evaluated independently. */
  unpairedMrd: number;
  /**
   * Smallest detectable gap when both models run the identical task set, at the
   * given score correlation.
   */
  pairedMrd: number;
  /** Worst-case per-task variance of the estimator, and where it peaks. */
  worstCaseVariance: number;
  worstCaseAtP: number;
  /** Tasks, after discounting for clustering. */
  effectiveTasks: number;
  designEffect: number;
}

/**
 * Variance inflation from clustered sampling.
 *
 *     deff = 1 + (m_bar - 1) * rho
 *
 * where m_bar is the average cluster size and rho the intra-cluster
 * correlation. With 40 tasks drawn from 8 repositories and rho = 0.3, deff is
 * 2.2 -- the benchmark has the resolving power of roughly 18 independent tasks,
 * not 40.
 *
 * Unequal cluster sizes inflate this further; the average understates it
 * slightly, which is the safe direction to be wrong in only if you say so.
 */
export function designEffect(clusterSizes: readonly number[], intraClusterCorrelation: number): number {
  if (clusterSizes.length === 0) return 1;
  if (intraClusterCorrelation < 0 || intraClusterCorrelation > 1) {
    throw new RangeError(`ICC must be in [0, 1], got ${intraClusterCorrelation}`);
  }
  const total = clusterSizes.reduce((a, b) => a + b, 0);
  const meanSize = total / clusterSizes.length;
  return Math.max(1, 1 + (meanSize - 1) * intraClusterCorrelation);
}

/**
 * What this benchmark, at this sampling design, can resolve.
 *
 * `pairedCorrelation` is how strongly two models' per-task scores move
 * together. Agent benchmarks run high -- hard tasks are hard for everyone -- so
 * 0.5 to 0.8 is typical and assuming 0 throws away real precision. It is a
 * parameter rather than a default because guessing it in either direction
 * changes the answer materially.
 */
export function resolvingPower(
  input: DesignInput,
  pairedCorrelation = 0,
): ResolvingPower {
  const { n, k, tasks, designEffect: deff = 1, z = Z95 } = input;

  if (tasks <= 0) throw new RangeError(`tasks must be positive, got ${tasks}`);
  if (deff < 1) throw new RangeError(`design effect cannot be below 1, got ${deff}`);
  if (pairedCorrelation < -1 || pairedCorrelation > 1) {
    throw new RangeError(`correlation must be in [-1, 1], got ${pairedCorrelation}`);
  }

  const { variance, atP } = maxPassAtKVariance(n, k);
  const effectiveTasks = tasks / deff;

  const halfWidth = z * Math.sqrt(variance / effectiveTasks);

  // A difference carries the uncertainty of both estimates. Independent
  // evaluation doubles the variance; a shared task set removes the correlated
  // part of it.
  const unpairedMrd = z * Math.sqrt((2 * variance) / effectiveTasks);
  const pairedMrd = z * Math.sqrt((2 * (1 - pairedCorrelation) * variance) / effectiveTasks);

  return {
    halfWidth,
    unpairedMrd,
    pairedMrd,
    worstCaseVariance: variance,
    worstCaseAtP: atP,
    effectiveTasks,
    designEffect: deff,
  };
}

/**
 * Tasks required to resolve a target difference -- the power analysis that
 * belongs BEFORE the run, not after it.
 *
 * Simulation in the Bayesian-evaluation literature (arXiv 2510.04265) puts
 * N = 80 as insufficient to separate closely matched models and N = 285 as
 * enough for roughly 96.9% correct ranking. This computes the equivalent for
 * a stated design instead of borrowing someone else's number.
 *
 * If the answer exceeds the benchmark you have, the honest move is to report
 * that the comparison cannot be made -- not to run it anyway and rank the
 * noise.
 */
export function requiredTasks(options: {
  n: number;
  k: number;
  /** The difference you want to be able to claim, in score points. */
  targetDifference: number;
  designEffect?: number;
  pairedCorrelation?: number;
  z?: number;
}): { tasks: number; effectiveTasks: number } {
  const {
    n,
    k,
    targetDifference,
    designEffect: deff = 1,
    pairedCorrelation = 0,
    z = Z95,
  } = options;

  if (targetDifference <= 0) {
    throw new RangeError(`targetDifference must be positive, got ${targetDifference}`);
  }

  const { variance } = maxPassAtKVariance(n, k);
  const effective = Math.ceil(
    (z * z * 2 * (1 - pairedCorrelation) * variance) / (targetDifference * targetDifference),
  );
  return { tasks: Math.ceil(effective * deff), effectiveTasks: effective };
}

export interface BenchmarkResolution {
  benchmark: string;
  tasks: number;
  n: number;
  k: number;
  resolution: ResolvingPower;
}

/**
 * Resolving power for a set of benchmark designs.
 *
 * Intended output: a published table saying what each major benchmark can
 * actually distinguish, alongside the rankings that fall inside it. Every
 * figure is recomputed here from the stated design rather than quoted, so a
 * reader who disagrees with an assumption can change it and rerun.
 */
export function resolutionTable(
  designs: ReadonlyArray<{
    benchmark: string;
    tasks: number;
    n: number;
    k: number;
    designEffect?: number;
  }>,
  pairedCorrelation = 0,
): BenchmarkResolution[] {
  return designs.map((d) => ({
    benchmark: d.benchmark,
    tasks: d.tasks,
    n: d.n,
    k: d.k,
    resolution: resolvingPower(
      { n: d.n, k: d.k, tasks: d.tasks, designEffect: d.designEffect },
      pairedCorrelation,
    ),
  }));
}
