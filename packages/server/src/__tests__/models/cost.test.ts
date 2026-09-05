import { describe, it, expect } from 'vitest';
import {
  costOfGeneration,
  efficiency,
  formatCost,
  pricingStatus,
  sumCosts,
  type CostAmount,
} from '../../models/cost.js';
import type { Pricing } from '../../models/registry.js';

const TOKENS: Pricing = {
  kind: 'tokens',
  tokens: { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
};
const HARDWARE: Pricing = { kind: 'hardware', hardware: { hourlyUsd: 3.6 } };
const UNKNOWN: Pricing = { kind: 'unknown' };

const known = (c: CostAmount): number => {
  if (!c.known) throw new Error(`expected a known cost, got: ${c.reason}`);
  return c.usd;
};

describe('never invent a price', () => {
  it('returns unknown when no pricing is configured', () => {
    const c = costOfGeneration(UNKNOWN, { inputTokens: 1000, outputTokens: 500 });
    expect(c.known).toBe(false);
  });

  it('returns unknown when the provider reported no usage', () => {
    // Missing token counts are not zero. Free and unmeasured are different.
    expect(costOfGeneration(TOKENS, {}).known).toBe(false);
    expect(costOfGeneration(TOKENS, { inputTokens: 100 }).known).toBe(false);
  });

  it('explains why, so an operator knows what to configure', () => {
    const c = costOfGeneration(UNKNOWN, { inputTokens: 1, outputTokens: 1 });
    expect(c.known).toBe(false);
    if (!c.known) expect(c.reason).toMatch(/No pricing is configured/);
  });

  it('renders unknown as a word, never as a number', () => {
    expect(formatCost({ known: false, reason: 'x' })).toBe('Unknown');
  });
});

describe('token pricing', () => {
  it('computes from per-million rates', () => {
    // 1M in at $10 + 1M out at $50.
    const c = costOfGeneration(TOKENS, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(known(c)).toBeCloseTo(60, 6);
  });

  it('handles realistic sub-cent amounts without rounding to zero', () => {
    const c = costOfGeneration(TOKENS, { inputTokens: 1_000, outputTokens: 200 });
    expect(known(c)).toBeCloseTo(0.01 + 0.01, 6);
    expect(formatCost(c)).not.toBe('0.0000 USD');
  });

  it('bills cached input at its own rate without double counting', () => {
    const pricing: Pricing = {
      kind: 'tokens',
      tokens: { inputPerMillionUsd: 10, outputPerMillionUsd: 50, cachedInputPerMillionUsd: 1 },
    };
    // 1M input of which 500k cached: 500k @ $10 + 500k @ $1 = $5.50, +0 output.
    const c = costOfGeneration(pricing, {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    });
    expect(known(c)).toBeCloseTo(5.5, 6);
  });

  it('does not assume a discount nobody configured', () => {
    // With no cached rate, cached tokens bill at the full input rate rather
    // than free — assuming a discount would understate the bill.
    const c = costOfGeneration(TOKENS, {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(known(c)).toBeCloseTo(10, 6);
  });

  it('bills reasoning tokens only when a separate rate exists', () => {
    const withRate: Pricing = {
      kind: 'tokens',
      tokens: { inputPerMillionUsd: 0, outputPerMillionUsd: 0, reasoningOutputPerMillionUsd: 100 },
    };
    const c = costOfGeneration(withRate, {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    expect(known(c)).toBeCloseTo(100, 6);

    // Without a rate the vendor folds them into output; adding them again
    // would double-bill.
    const without = costOfGeneration(TOKENS, {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 1_000_000,
    });
    expect(known(without)).toBe(0);
  });
});

describe('hardware pricing', () => {
  it('computes from occupancy', () => {
    // $3.60/hour for 30 minutes.
    const c = costOfGeneration(HARDWARE, {}, { occupancySeconds: 1800 });
    expect(known(c)).toBeCloseTo(1.8, 6);
  });

  it('is unknown when occupancy was not recorded', () => {
    expect(costOfGeneration(HARDWARE, {}).known).toBe(false);
  });

  it('does not require token counts', () => {
    // A local model priced by GPU-hour needs no usage report.
    expect(costOfGeneration(HARDWARE, {}, { occupancySeconds: 60 }).known).toBe(true);
  });
});

describe('unknown is contagious when summing', () => {
  it('sums known costs', () => {
    const c = sumCosts([
      { known: true, usd: 1 },
      { known: true, usd: 2.5 },
    ]);
    expect(known(c)).toBeCloseTo(3.5, 6);
  });

  it('one unknown makes the total unknown', () => {
    // Summing only the priced contributors would understate the total while
    // looking complete.
    const c = sumCosts([
      { known: true, usd: 100 },
      { known: false, reason: 'No pricing for qwen-local.' },
    ]);
    expect(c.known).toBe(false);
  });

  it('says how many were unknown, so the fix is obvious', () => {
    const c = sumCosts([
      { known: false, reason: 'a' },
      { known: false, reason: 'b' },
      { known: true, usd: 1 },
    ]);
    if (!c.known) expect(c.reason).toMatch(/2 of 3/);
  });

  it('an empty set costs zero, not unknown', () => {
    expect(known(sumCosts([]))).toBe(0);
  });
});

describe('efficiency', () => {
  it('computes cost per task and per success', () => {
    const e = efficiency({
      totalCost: { known: true, usd: 10 },
      tasksAttempted: 100,
      tasksSucceeded: 50,
    });
    expect(known(e.costPerTask)).toBeCloseTo(0.1, 6);
    expect(known(e.costPerSuccess)).toBeCloseTo(0.2, 6);
  });

  it('refuses to divide by zero successes', () => {
    // Not infinity and not zero: a ratio with no denominator, stated as such.
    const e = efficiency({
      totalCost: { known: true, usd: 42 },
      tasksAttempted: 10,
      tasksSucceeded: 0,
    });
    expect(e.costPerSuccess.known).toBe(false);
    if (!e.costPerSuccess.known) {
      expect(e.costPerSuccess.reason).toMatch(/undefined/);
      // The spend still happened and is still reported.
      expect(e.costPerSuccess.reason).toContain('42');
    }
  });

  it('propagates an unknown total to both ratios', () => {
    const e = efficiency({
      totalCost: { known: false, reason: 'no pricing' },
      tasksAttempted: 10,
      tasksSucceeded: 5,
    });
    expect(e.costPerTask.known).toBe(false);
    expect(e.costPerSuccess.known).toBe(false);
  });

  it('shows that a cheap unreliable model is not cheap', () => {
    // The number procurement actually needs.
    const cheapFlaky = efficiency({
      totalCost: { known: true, usd: 1 },
      tasksAttempted: 100,
      tasksSucceeded: 10,
    });
    const dearReliable = efficiency({
      totalCost: { known: true, usd: 5 },
      tasksAttempted: 100,
      tasksSucceeded: 95,
    });
    expect(known(cheapFlaky.costPerTask)).toBeLessThan(known(dearReliable.costPerTask));
    expect(known(cheapFlaky.costPerSuccess)).toBeGreaterThan(known(dearReliable.costPerSuccess));
  });
});

describe('pricingStatus', () => {
  it('reports a token-priced model with its rates', () => {
    const s = pricingStatus({ pricing: TOKENS, displayName: 'M' });
    expect(s.priced).toBe(true);
    expect(s.detail).toContain('$10/M in');
  });

  it('reports an unpriced model and says cost will be unknown', () => {
    const s = pricingStatus({ pricing: UNKNOWN, displayName: 'Qwen local' });
    expect(s.priced).toBe(false);
    expect(s.detail).toMatch(/rather than estimated/);
  });
});
