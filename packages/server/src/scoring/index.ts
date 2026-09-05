/**
 * Statistically defensible scoring for agent evaluation.
 *
 * The field competes on coverage -- more benchmarks, more red teamers, more
 * traces. Nobody competes on being correct, and the literature says the field
 * is not correct: intervals are systematically too narrow, clustered tasks are
 * treated as independent, the CLT is applied below the sample sizes where it
 * holds, and 50-model leaderboards publish 1,225 uncorrected comparisons of
 * which roughly 61 are significant by chance alone.
 *
 * Volume is a capital problem. Validity is a methodology problem, and
 * methodology is the one thing a small careful team can do better than a large
 * one.
 *
 * Pipeline order:
 *
 *   mrd          before running anything -- can this benchmark resolve the
 *                difference you intend to claim? If not, say so and stop.
 *   estimators   pass@k, pass^k, G-pass, mG-pass. Four questions, not one.
 *   intervals    method chosen from the data, and disclosed.
 *   comparison   paired, Holm-corrected, tiered rather than ordinal.
 *   composite    validity multipliers, each separately visible.
 */

export {
  logChoose,
  passAtK,
  passPowK,
  gPassAtK,
  mGPassAtK,
  passAtKVariance,
  maxPassAtKVariance,
} from './estimators.js';

export {
  designEffect,
  resolvingPower,
  requiredTasks,
  resolutionTable,
  type DesignInput,
  type ResolvingPower,
  type BenchmarkResolution,
} from './mrd.js';

export {
  clusteredStandardError,
  clusterBootstrapInterval,
  clopperPearsonInterval,
  scoreInterval,
  type Observation,
  type Interval,
  type IntervalMethod,
} from './intervals.js';

export {
  pairedComparison,
  holmAdjust,
  rankModels,
  type TaskScore,
  type ModelScores,
  type PairedComparison,
  type Tier,
  type Ranking,
} from './comparison.js';

export {
  compositeScore,
  type ValidityFactors,
  type CompositeScore,
} from './composite.js';
