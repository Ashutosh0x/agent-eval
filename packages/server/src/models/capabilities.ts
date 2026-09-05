/**
 * Capability negotiation.
 *
 * A benchmark declares what it needs; a model declares what it has; this
 * decides whether the pair may run. The requirement it exists to satisfy:
 *
 *   NEVER SILENTLY RUN AN INCOMPATIBLE MODEL.
 *
 * That is a scoring-integrity rule, not a convenience. A vision benchmark run
 * against a text-only model does not produce a low score — it produces a
 * meaningless one, and a leaderboard that shows it next to real scores has
 * been quietly corrupted. Excluding the model and saying why is the only
 * honest outcome.
 *
 * THE THREE-STATE PROBLEM. Capabilities are `supported`, `unsupported` or
 * `unknown`, and `unknown` is the interesting one. Treating it as supported
 * runs a benchmark that may be invalid; treating it as unsupported excludes
 * models that would have worked. Neither is right in every deployment, so the
 * policy is a parameter — but the DEFAULT is to exclude, because a wrongly
 * excluded model is a visible gap in a matrix while a wrongly included one is
 * an invisible corruption of a score.
 */

import type { Support } from '../providers/types.js';
import type { ModelCapabilities, RegisteredModel } from './registry.js';

/** The capabilities a benchmark can require. */
export type Capability =
  | 'streaming'
  | 'tools'
  | 'parallelToolCalls'
  | 'vision'
  | 'audio'
  | 'structuredOutput'
  | 'jsonMode'
  | 'reasoning'
  | 'multiTurn'
  | 'systemMessages';

export const CAPABILITIES: readonly Capability[] = [
  'streaming',
  'tools',
  'parallelToolCalls',
  'vision',
  'audio',
  'structuredOutput',
  'jsonMode',
  'reasoning',
  'multiTurn',
  'systemMessages',
] as const;

export interface BenchmarkRequirements {
  /** Capabilities without which the benchmark is invalid. */
  required?: Capability[];
  /** Minimum usable context. A model below this cannot hold the task. */
  minContextWindow?: number;
  /** Minimum output budget, for tasks that must emit a lot. */
  minOutputTokens?: number;
}

/** What to do when a capability is `unknown`. */
export type UnknownPolicy =
  /** Exclude. The default, and the safe answer for scoring integrity. */
  | 'exclude'
  /** Include and mark the result as lower-confidence. */
  | 'include_flagged'
  /** Probe before deciding. The caller must supply a prober. */
  | 'probe';

export interface CompatibilityDecision {
  compatible: boolean;
  /** Capabilities the benchmark needs that the model does not have. */
  missing: Capability[];
  /** Capabilities the benchmark needs whose support could not be established. */
  unknown: Capability[];
  /** Context or output budget failures, stated with the numbers. */
  limits: string[];
  /** One sentence for a human reading a skipped row in a matrix. */
  reason: string;
  /**
   * True when the model runs but the result deserves an asterisk — an
   * `unknown` capability was admitted under `include_flagged`.
   */
  flagged: boolean;
}

function readCapability(caps: ModelCapabilities, c: Capability): Support {
  // Every Capability is a key of ModelCapabilities whose value is a Support,
  // so this is total; the annotation records that for a reader.
  const value: Support = caps[c];
  return value;
}

/**
 * Decide whether a model may run a benchmark.
 *
 * Pure and synchronous, so the whole matrix can be computed before a single
 * job is scheduled and the review screen can show exactly what will be skipped.
 */
export function checkCompatibility(
  model: Pick<RegisteredModel, 'capabilities' | 'contextWindow' | 'maxOutputTokens' | 'displayName'>,
  requirements: BenchmarkRequirements,
  unknownPolicy: UnknownPolicy = 'exclude',
): CompatibilityDecision {
  const missing: Capability[] = [];
  const unknown: Capability[] = [];
  const limits: string[] = [];

  for (const capability of requirements.required ?? []) {
    const support = readCapability(model.capabilities, capability);
    if (support === 'unsupported') missing.push(capability);
    else if (support === 'unknown') unknown.push(capability);
  }

  // Context and output budgets. An unknown window is NOT assumed adequate —
  // silently running a task that overflows produces a truncation the score
  // reads as a capability failure.
  if (requirements.minContextWindow !== undefined) {
    if (model.contextWindow === undefined) {
      limits.push(
        `context window is unknown, and the benchmark needs at least ${requirements.minContextWindow} tokens`,
      );
    } else if (model.contextWindow < requirements.minContextWindow) {
      limits.push(
        `context window ${model.contextWindow} is below the required ${requirements.minContextWindow}`,
      );
    }
  }
  if (requirements.minOutputTokens !== undefined) {
    if (model.maxOutputTokens === undefined) {
      limits.push(
        `max output tokens is unknown, and the benchmark needs at least ${requirements.minOutputTokens}`,
      );
    } else if (model.maxOutputTokens < requirements.minOutputTokens) {
      limits.push(
        `max output ${model.maxOutputTokens} is below the required ${requirements.minOutputTokens}`,
      );
    }
  }

  const unknownBlocks = unknown.length > 0 && unknownPolicy !== 'include_flagged';
  const compatible = missing.length === 0 && limits.length === 0 && !unknownBlocks;
  const flagged = compatible && unknown.length > 0;

  return {
    compatible,
    missing,
    unknown,
    limits,
    flagged,
    reason: explain({ missing, unknown, limits, compatible, flagged, unknownPolicy, model }),
  };
}

function explain(input: {
  missing: Capability[];
  unknown: Capability[];
  limits: string[];
  compatible: boolean;
  flagged: boolean;
  unknownPolicy: UnknownPolicy;
  model: { displayName: string };
}): string {
  const { missing, unknown, limits, compatible, flagged, unknownPolicy, model } = input;

  if (compatible && !flagged) return `${model.displayName} meets every requirement.`;
  if (compatible && flagged) {
    return (
      `${model.displayName} is running with unverified support for ${unknown.join(', ')}. ` +
      'Results carry lower confidence until a capability probe confirms it.'
    );
  }

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`does not support ${missing.join(', ')}`);
  if (unknown.length > 0 && unknownPolicy === 'exclude') {
    parts.push(
      `has unverified support for ${unknown.join(', ')} ` +
        '(excluded by default: an unverified capability can invalidate a score silently, ' +
        'whereas an excluded model is a visible gap)',
    );
  }
  if (unknown.length > 0 && unknownPolicy === 'probe') {
    parts.push(`needs a capability probe for ${unknown.join(', ')}`);
  }
  for (const l of limits) parts.push(l);

  return `${model.displayName} was skipped: it ${parts.join('; ')}.`;
}

/** Requirements a task/benchmark declares. Narrow on purpose. */
export function requirementsFrom(input: {
  vision?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  audio?: boolean;
  minContextWindow?: number;
  minOutputTokens?: number;
}): BenchmarkRequirements {
  const required: Capability[] = [];
  if (input.vision) required.push('vision');
  if (input.tools) required.push('tools');
  if (input.structuredOutput) required.push('structuredOutput');
  if (input.reasoning) required.push('reasoning');
  if (input.audio) required.push('audio');
  return {
    ...(required.length > 0 ? { required } : {}),
    ...(input.minContextWindow !== undefined ? { minContextWindow: input.minContextWindow } : {}),
    ...(input.minOutputTokens !== undefined ? { minOutputTokens: input.minOutputTokens } : {}),
  };
}

// ------------------------------------------------------------------- matrix

export interface MatrixEntry {
  modelId: string;
  displayName: string;
  decision: CompatibilityDecision;
}

export interface CompatibilityMatrix {
  included: MatrixEntry[];
  excluded: MatrixEntry[];
  /** Included but with an unverified capability. */
  flagged: MatrixEntry[];
}

/**
 * Partition a set of models against one benchmark's requirements.
 *
 * Returns exclusions as data rather than dropping them, so the benchmark
 * review screen can show "9 models, 2 skipped, here is why" before anything
 * runs. A skipped model that never appears anywhere is indistinguishable from
 * one nobody selected.
 */
export function buildCompatibilityMatrix(
  models: readonly Pick<
    RegisteredModel,
    'modelId' | 'displayName' | 'capabilities' | 'contextWindow' | 'maxOutputTokens'
  >[],
  requirements: BenchmarkRequirements,
  unknownPolicy: UnknownPolicy = 'exclude',
): CompatibilityMatrix {
  const included: MatrixEntry[] = [];
  const excluded: MatrixEntry[] = [];
  const flagged: MatrixEntry[] = [];

  for (const m of models) {
    const decision = checkCompatibility(m, requirements, unknownPolicy);
    const entry: MatrixEntry = { modelId: m.modelId, displayName: m.displayName, decision };
    if (decision.compatible) {
      included.push(entry);
      if (decision.flagged) flagged.push(entry);
    } else {
      excluded.push(entry);
    }
  }

  return { included, excluded, flagged };
}
