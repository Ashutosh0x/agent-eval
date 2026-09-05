/**
 * The validity-adjusted composite score.
 *
 * Statistics fix precision. They do nothing for accuracy: a perfectly computed
 * confidence interval around a contaminated benchmark scored by a gameable
 * grader is a precise measurement of the wrong thing. The multipliers here are
 * the accuracy half.
 *
 *     score = passAtK(budget)
 *           * (1 - contaminationDiscount)
 *           * (1 - gamingRate)
 *           * verifierConfidence
 *
 * Two rules govern how this is reported, and they are the reason to trust it.
 *
 * EVERY MULTIPLIER STAYS VISIBLE. A reader who disagrees with a contamination
 * discount can recompute without it, because the base estimate and each factor
 * are all carried in the result. A composite that collapses to one opaque
 * number is a number nobody can argue with, which is not the same as one nobody
 * can fault.
 *
 * AN UNASSESSED FACTOR IS NOT A CLEAN ONE. Passing `null` for contamination
 * does not mean "no contamination", it means nobody looked -- so the factor is
 * omitted, the composite is marked `provisional`, and the reason is listed.
 * Treating unchecked as clean is how a leaderboard launders an absence of
 * evidence into a claim, and it is the specific failure this project exists to
 * avoid.
 */

import type { Interval } from './intervals.js';

export interface ValidityFactors {
  /**
   * Fraction of the score attributable to the model having seen the tasks.
   * Null when no contamination check ran.
   *
   * CyberGym derives from public OSS-Fuzz data, so any model released after
   * that corpus may have seen the patches or the discussions around them.
   */
  contaminationDiscount: number | null;
  /**
   * Fraction of runs where the agent was caught gaming rather than solving.
   * Null when no scan ran.
   *
   * UK AISI found all five frontier models it tested attempted to cheat, over
   * 475 runs each. A score with no gaming scan attached is not a measurement,
   * and zero is not the safe default -- unmeasured is.
   */
  gamingRate: number | null;
  /**
   * How much of the grader's reward survives isomorphic perturbation testing
   * and fuzzing, in [0, 1]. Null when the grader was not assessed.
   *
   * This is the output of the robustness assessment: a grader that pays full
   * marks to an empty submission has a confidence near zero, and every score it
   * produced inherits that.
   */
  verifierConfidence: number | null;
}

export interface CompositeScore {
  /** The estimator output before any validity adjustment. */
  base: Interval;
  /** Each factor applied, in order, with what it did. */
  applied: Array<{ factor: string; multiplier: number; effect: number }>;
  /** Factors that could not be applied, and why. */
  omitted: Array<{ factor: string; reason: string }>;
  score: number;
  lower: number;
  upper: number;
  /**
   * True when at least one validity factor went unassessed. A provisional
   * composite is not comparable with a complete one and must not be ranked
   * against it without saying so.
   */
  provisional: boolean;
  /** Full recomputation trail, for the methodology page and the bundle. */
  derivation: string;
}

/**
 * Apply validity adjustments to an interval.
 *
 * The interval is scaled by the same product as the point estimate, then
 * widened in proportion to how little the verifier can be trusted. The widening
 * is deliberate and separate from the scaling: a weak grader does not just
 * lower a score, it makes the score less certain, and those are different
 * statements that a single multiplier would conflate.
 */
export function compositeScore(
  base: Interval,
  factors: ValidityFactors,
): CompositeScore {
  const applied: CompositeScore['applied'] = [];
  const omitted: CompositeScore['omitted'] = [];

  let multiplier = 1;

  const consider = (
    name: string,
    value: number | null,
    toMultiplier: (v: number) => number,
    missingReason: string,
  ): void => {
    if (value === null) {
      omitted.push({ factor: name, reason: missingReason });
      return;
    }
    if (value < 0 || value > 1) {
      throw new RangeError(`${name} must be in [0, 1], got ${value}`);
    }
    const m = toMultiplier(value);
    const before = multiplier;
    multiplier *= m;
    applied.push({
      factor: name,
      multiplier: m,
      effect: (multiplier - before) * base.estimate,
    });
  };

  consider(
    'contamination',
    factors.contaminationDiscount,
    (v) => 1 - v,
    'No contamination check ran. The model cutoff was not compared against the ' +
      'corpus date, so overlap is unknown rather than absent.',
  );
  consider(
    'gaming',
    factors.gamingRate,
    (v) => 1 - v,
    'No gaming scan ran. Runs were not checked for reward hacking, so the score ' +
      'may include rewards for work that did not happen.',
  );
  consider(
    'verifier',
    factors.verifierConfidence,
    (v) => v,
    'The grader was not assessed for robustness. Its reward may be obtainable ' +
      'without solving the task.',
  );

  // A grader that cannot be trusted makes the estimate less certain, not just
  // smaller. Full confidence leaves the width alone; zero confidence doubles it.
  const uncertaintyInflation =
    factors.verifierConfidence === null ? 1 : 1 + (1 - factors.verifierConfidence);

  const score = base.estimate * multiplier;
  const halfWidth = ((base.upper - base.lower) / 2) * multiplier * uncertaintyInflation;

  const provisional = omitted.length > 0;

  const derivation = [
    `base ${base.estimate.toFixed(4)} (${base.method}, n=${base.n}, clusters=${base.clusters})`,
    ...applied.map((a) => `x ${a.multiplier.toFixed(4)} [${a.factor}]`),
    `= ${score.toFixed(4)}`,
    `interval half-width scaled by ${multiplier.toFixed(4)}` +
      (uncertaintyInflation === 1
        ? ''
        : ` then widened ${uncertaintyInflation.toFixed(2)}x for verifier uncertainty`),
    provisional
      ? `PROVISIONAL: ${omitted.map((o) => o.factor).join(', ')} unassessed`
      : 'all validity factors assessed',
  ].join('\n');

  return {
    base,
    applied,
    omitted,
    score,
    lower: Math.max(0, score - halfWidth),
    upper: Math.min(1, score + halfWidth),
    provisional,
    derivation,
  };
}
