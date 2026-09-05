/**
 * Cost accounting.
 *
 * THE ONE RULE: never invent a price.
 *
 * If pricing was not configured, the answer is `unknown` and it stays
 * `unknown` all the way to the leaderboard. That is unusual for a metrics
 * layer and it is deliberate — a fabricated cost figure does not stay in the
 * dashboard. It gets exported, put in a comparison table, and used to justify
 * choosing one model over another. A visible "unknown" prompts someone to
 * configure the rate; a plausible wrong number never gets questioned.
 *
 * The second rule follows from the first: a total over a mixed set is only
 * known when EVERY contributor is known. One unpriced model in a benchmark
 * makes the benchmark total unknown rather than "the sum of the ones we
 * happened to have prices for", which would understate it while looking
 * complete.
 */

import type { Usage } from '../providers/types.js';
import type { Pricing, RegisteredModel } from './registry.js';

export type CostAmount =
  | { known: true; usd: number }
  /** Why it could not be computed, for the UI to show instead of a number. */
  | { known: false; reason: string };

export const UNKNOWN_COST = (reason: string): CostAmount => ({ known: false, reason });

/** Hardware time consumed by a self-hosted run, for the hardware cost model. */
export interface HardwareUsage {
  /** Wall-clock seconds the model occupied the hardware. */
  occupancySeconds: number;
}

/**
 * Cost of a single generation.
 *
 * Token pricing is quoted per million tokens, which is how every vendor
 * publishes it; dividing here rather than at configuration time means the
 * stored number matches the vendor's page and can be checked against it.
 */
export function costOfGeneration(
  pricing: Pricing,
  usage: Usage,
  hardware?: HardwareUsage,
): CostAmount {
  if (pricing.kind === 'unknown') {
    return UNKNOWN_COST('No pricing is configured for this model.');
  }

  if (pricing.kind === 'hardware') {
    if (!hardware) {
      return UNKNOWN_COST(
        'This model is priced by hardware time, but no occupancy was recorded for the run.',
      );
    }
    const hours = hardware.occupancySeconds / 3600;
    return { known: true, usd: round(pricing.hardware.hourlyUsd * hours) };
  }

  const t = pricing.tokens;
  const input = usage.inputTokens;
  const output = usage.outputTokens;

  // Missing token counts are not zero. A provider that reported no usage
  // means the cost is unknown, not free.
  if (input === undefined || output === undefined) {
    return UNKNOWN_COST(
      'The provider did not report token usage for this call, so its cost cannot be computed.',
    );
  }

  // Cached input, where the vendor prices it separately, is billed at its own
  // rate and must not be double-counted in the ordinary input total.
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, input - cached);

  let usd =
    (uncachedInput / 1_000_000) * t.inputPerMillionUsd +
    (output / 1_000_000) * t.outputPerMillionUsd;

  if (cached > 0) {
    // Absent a cached rate, cached tokens fall back to the full input rate
    // rather than to zero — assuming a discount nobody configured would
    // understate the bill.
    const cachedRate = t.cachedInputPerMillionUsd ?? t.inputPerMillionUsd;
    usd += (cached / 1_000_000) * cachedRate;
  }

  // Reasoning tokens, where billed separately. When the vendor folds them into
  // output the caller should not populate this field, and it stays zero.
  const reasoning = usage.reasoningTokens ?? 0;
  if (reasoning > 0 && t.reasoningOutputPerMillionUsd !== undefined) {
    usd += (reasoning / 1_000_000) * t.reasoningOutputPerMillionUsd;
  }

  return { known: true, usd: round(usd) };
}

/**
 * Sum costs.
 *
 * Unknown is contagious by design: see the note at the top. The reason names
 * how many contributors were unknown so the UI can say what to fix.
 */
export function sumCosts(costs: readonly CostAmount[]): CostAmount {
  if (costs.length === 0) return { known: true, usd: 0 };
  const unknowns = costs.filter((c) => !c.known);
  if (unknowns.length > 0) {
    const first = unknowns[0] as { known: false; reason: string };
    return UNKNOWN_COST(
      unknowns.length === 1
        ? first.reason
        : `${unknowns.length} of ${costs.length} costs are unknown. First: ${first.reason}`,
    );
  }
  const total = costs.reduce((acc, c) => acc + (c as { known: true; usd: number }).usd, 0);
  return { known: true, usd: round(total) };
}

export interface EfficiencyInput {
  totalCost: CostAmount;
  tasksAttempted: number;
  tasksSucceeded: number;
}

export interface Efficiency {
  costPerTask: CostAmount;
  /**
   * The number that actually matters for procurement: a cheap model that fails
   * four times out of five is not cheap.
   */
  costPerSuccess: CostAmount;
}

export function efficiency(input: EfficiencyInput): Efficiency {
  const { totalCost, tasksAttempted, tasksSucceeded } = input;

  if (!totalCost.known) {
    return { costPerTask: totalCost, costPerSuccess: totalCost };
  }

  const costPerTask: CostAmount =
    tasksAttempted > 0
      ? { known: true, usd: round(totalCost.usd / tasksAttempted) }
      : UNKNOWN_COST('No tasks were attempted.');

  // Zero successes is not an infinite or a zero cost-per-success; it is a
  // ratio with no denominator, and saying so is more useful than either.
  const costPerSuccess: CostAmount =
    tasksSucceeded > 0
      ? { known: true, usd: round(totalCost.usd / tasksSucceeded) }
      : UNKNOWN_COST(
          `No task succeeded, so cost per successful task is undefined. ` +
            `$${totalCost.usd.toFixed(4)} was spent across ${tasksAttempted} attempt(s).`,
        );

  return { costPerTask, costPerSuccess };
}

/** Render for a table cell. Never prints a number it does not have. */
export function formatCost(c: CostAmount, currency = 'USD'): string {
  if (!c.known) return 'Unknown';
  if (c.usd === 0) return `0.0000 ${currency}`;
  // Sub-cent precision: agent evaluations frequently cost fractions of a cent
  // per call, and rounding to 2dp would print $0.00 for real spend.
  return `${c.usd.toFixed(c.usd < 0.01 ? 6 : 4)} ${currency}`;
}

/** Whether a model can produce a cost figure at all, for the review screen. */
export function pricingStatus(model: Pick<RegisteredModel, 'pricing' | 'displayName'>): {
  priced: boolean;
  detail: string;
} {
  switch (model.pricing.kind) {
    case 'tokens':
      return {
        priced: true,
        detail:
          `$${model.pricing.tokens.inputPerMillionUsd}/M in, ` +
          `$${model.pricing.tokens.outputPerMillionUsd}/M out` +
          (model.pricing.tokens.asOf ? ` (as of ${model.pricing.tokens.asOf})` : ''),
      };
    case 'hardware':
      return {
        priced: true,
        detail: `$${model.pricing.hardware.hourlyUsd}/hour of hardware time`,
      };
    default:
      return {
        priced: false,
        detail:
          `No pricing configured for ${model.displayName}. Cost will be reported as unknown ` +
          'rather than estimated.',
      };
  }
}

function round(usd: number): number {
  // Six decimal places: providers bill at sub-cent granularity and summing
  // thousands of small calls at 2dp drifts materially.
  return Math.round(usd * 1e6) / 1e6;
}
