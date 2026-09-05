/**
 * The small amount of statistics a robustness report needs to be honest.
 *
 * A grader assessment runs a handful of probes against a few dozen tasks. That
 * is a small sample against a proportion that is often near 0 or near 1, which
 * is exactly where the normal approximation most people reach for stops
 * working: at 3 open channels out of 30, the textbook interval extends below
 * zero, and at 30 out of 30 it collapses to a point and claims certainty from
 * thirty observations.
 *
 * Wilson's interval is used instead. It is bounded within [0, 1] by
 * construction, it does not degenerate at the extremes, and it is the standard
 * recommendation for exactly this regime. Reporting "100% gameable" from 30
 * tasks without an interval is the same overclaiming this project refuses
 * everywhere else.
 */

import type { Proportion } from './types.js';

/** 97.5th percentile of the standard normal: a 95% two-sided interval. */
const Z = 1.959963984540054;

/**
 * Wilson score interval.
 *
 * Note what it does at the edges, because that is the reason it is here:
 * 0 of 20 gives roughly [0, 0.16], not [0, 0]. Twenty clean tasks are evidence
 * of a low rate, not proof of a zero one.
 */
export function proportion(count: number, total: number): Proportion {
  if (total <= 0) {
    return { count: 0, total: 0, rate: 0, lower: 0, upper: 0 };
  }
  const p = count / total;
  const z2 = Z * Z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const spread =
    (Z / denominator) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    count,
    total,
    rate: p,
    lower: Math.max(0, centre - spread),
    upper: Math.min(1, centre + spread),
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Population standard deviation.
 *
 * Population rather than sample because these are all the repeats that were
 * run, not a sample drawn from a larger set of repeats. Its only job here is to
 * answer "did this grader return the same number twice", and for that the
 * distinction between n and n-1 is noise -- but picking one deliberately beats
 * picking one accidentally.
 */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** Linear-interpolated quantile over a copy of the input. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (pos - lower) * (sorted[upper]! - sorted[lower]!);
}
