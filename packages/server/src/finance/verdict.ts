/**
 * Deterministic adjudication of "which model is better".
 *
 * This module exists because of a specific, checkable failure in the published
 * finance leaderboards. In August 2026 one of them reported a top score of
 * 78.7 and a runner-up of 78.6, and presented that 0.1-point gap as a rank
 * order. No interval was published alongside it, so a reader could not tell
 * whether the ordering was a finding or noise.
 *
 * The arithmetic in `scoring/mrd.ts` answers that directly: a benchmark of a
 * few hundred or a few thousand tasks cannot resolve a tenth of a point. The
 * ordering was noise, and this module says so in words rather than leaving the
 * reader to work it out.
 *
 * The conclusion is computed from the numbers and never written by a model. A
 * language model may summarise the output of this module afterwards, but
 * nothing it says may change the relationship reported here.
 */

import { pairedComparison, type ModelScores, type PairedComparison } from '../scoring/comparison.js';
import { resolvingPower } from '../scoring/mrd.js';

/**
 * What the evidence supports about two models.
 *
 * `INDISTINGUISHABLE` is a real finding rather than a failure to find one: it
 * says the benchmark was run and lacks the resolution to separate these two.
 */
export type Relationship =
  | 'A_BETTER'
  | 'B_BETTER'
  | 'INDISTINGUISHABLE'
  | 'INSUFFICIENT_DATA';

/**
 * How much weight the relationship carries.
 *
 * Derived from the size of the observed gap against the smallest gap the
 * design can detect, so it is a statement about the benchmark rather than a
 * feeling about the result.
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface HeadToHead {
  readonly a: string;
  readonly b: string;
  readonly relationship: Relationship;
  readonly confidence: Confidence;
  /** The underlying paired statistics, carried through unmodified. */
  readonly comparison: PairedComparison;
  /** Smallest gap this design could have detected, in the score's own units. */
  readonly mrd: number;
  /** Plain-language conclusion, generated from the numbers above. */
  readonly explanation: string;
}

export interface HeadToHeadOptions {
  /**
   * Variance inflation from clustered tasks. Finance tasks drawn from the same
   * filing, issuer or sector are not independent, and treating them as
   * independent is what produces intervals about a third of their true width.
   * Defaults to 1.0, which is an assumption and is usually wrong.
   */
  readonly designEffect?: number;
  /** Attempts the score is reported over, for pass@k designs. */
  readonly k?: number;
  /** Samples drawn per task. */
  readonly n?: number;
  /** Fewer shared tasks than this yields INSUFFICIENT_DATA. */
  readonly minimumTasks?: number;
  readonly alpha?: number;
  readonly seed?: number;
}

/**
 * Adjudicate two models over the tasks they both attempted.
 *
 * The relationship is decided by two independent conditions, and both must
 * hold before a winner is declared: the paired difference must be significant
 * after correction, AND the observed gap must exceed the smallest gap the
 * design could resolve. A gap can be significant and still smaller than the
 * MRD when the task set is large but the effect is tiny, and reporting that as
 * a ranking is how a 0.1-point difference becomes a headline.
 */
export function headToHead(
  a: ModelScores,
  b: ModelScores,
  options: HeadToHeadOptions = {},
): HeadToHead {
  const {
    designEffect = 1,
    k = 1,
    n = 1,
    minimumTasks = 30,
    alpha = 0.05,
    seed,
  } = options;

  const comparison = pairedComparison(a, b, {
    alpha,
    ...(seed !== undefined ? { seed } : {}),
  });

  const tasks = comparison.tasksCompared;

  if (tasks === 0) {
    return {
      a: a.model,
      b: b.model,
      relationship: 'INSUFFICIENT_DATA',
      confidence: 'LOW',
      comparison,
      mrd: Number.POSITIVE_INFINITY,
      explanation:
        `${a.model} and ${b.model} share no tasks, so they were not evaluated ` +
        `under the same conditions and cannot be compared.`,
    };
  }

  const power = resolvingPower({ n, k, tasks, designEffect }, comparison.correlation);
  const mrd = power.pairedMrd;
  const gap = Math.abs(comparison.difference);
  const leader = comparison.difference > 0 ? a.model : b.model;
  const trailer = comparison.difference > 0 ? b.model : a.model;

  if (tasks < minimumTasks) {
    return {
      a: a.model,
      b: b.model,
      relationship: 'INSUFFICIENT_DATA',
      confidence: 'LOW',
      comparison,
      mrd,
      explanation:
        `${a.model} and ${b.model} share only ${tasks} ${tasks === 1 ? 'task' : 'tasks'}, ` +
        `below the ${minimumTasks} required to report a comparison. The observed gap of ` +
        `${format(gap)} may be entirely task selection.`,
    };
  }

  const significant = comparison.pValue < alpha;
  const resolvable = gap > mrd;

  if (!significant || !resolvable) {
    return {
      a: a.model,
      b: b.model,
      relationship: 'INDISTINGUISHABLE',
      confidence: 'LOW',
      comparison,
      mrd,
      explanation: explainTie(a.model, b.model, comparison, mrd, significant, resolvable),
    };
  }

  return {
    a: a.model,
    b: b.model,
    relationship: comparison.difference > 0 ? 'A_BETTER' : 'B_BETTER',
    confidence: gap > 2 * mrd ? 'HIGH' : 'MEDIUM',
    comparison,
    mrd,
    explanation:
      `${leader} outperformed ${trailer} by ${format(gap)} across ` +
      `${comparison.tasksCompared} paired tasks ` +
      `(95% CI ${format(comparison.lower)} to ${format(comparison.upper)}, ` +
      `p = ${comparison.pValue.toFixed(4)}). ` +
      `The smallest gap this design could resolve is ${format(mrd)}, and the ` +
      `observed gap exceeds it, so the ordering is supported by the evidence.`,
  };
}

function explainTie(
  aName: string,
  bName: string,
  comparison: PairedComparison,
  mrd: number,
  significant: boolean,
  resolvable: boolean,
): string {
  const gap = Math.abs(comparison.difference);
  const head =
    `${aName} and ${bName} are statistically indistinguishable on this benchmark. ` +
    `The observed gap is ${format(gap)} across ${comparison.tasksCompared} paired tasks.`;

  if (!resolvable) {
    return (
      `${head} The smallest gap this design could resolve is ${format(mrd)}, which is ` +
      `larger than the gap itself, so the ordering carries no information. ` +
      `Separating them would require substantially more tasks, not a rerun.`
    );
  }

  return (
    `${head} The 95% confidence interval on the difference is ` +
    `${format(comparison.lower)} to ${format(comparison.upper)}, which includes zero ` +
    `(p = ${comparison.pValue.toFixed(4)}). The evidence does not establish that either ` +
    `model is better.`
  );
}

function format(value: number): string {
  if (!Number.isFinite(value)) return 'an unbounded amount';
  return Math.abs(value) < 0.01 ? value.toFixed(5) : value.toFixed(4);
}

/**
 * How many tasks a benchmark would need before a given gap becomes reportable.
 *
 * This is the question a published leaderboard should have to answer before
 * printing a rank order, and it is the direct check on a headline such as
 * "78.7 versus 78.6". Returns null when the gap stays unresolvable within the
 * search bound, which is itself the finding.
 */
export function tasksRequiredToResolve(
  gap: number,
  options: {
    readonly n?: number;
    readonly k?: number;
    readonly designEffect?: number;
    readonly correlation?: number;
    readonly maxTasks?: number;
  } = {},
): number | null {
  const { n = 1, k = 1, designEffect = 1, correlation = 0, maxTasks = 10_000_000 } = options;
  if (gap <= 0) return null;

  // The MRD falls monotonically with task count, so a binary search over the
  // count is exact rather than approximate.
  let low = 1;
  let high = maxTasks;

  if (resolvingPower({ n, k, tasks: high, designEffect }, correlation).pairedMrd >= gap) {
    return null;
  }

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (resolvingPower({ n, k, tasks: mid, designEffect }, correlation).pairedMrd < gap) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}
