import { describe, it, expect } from 'vitest';
import {
  compareFinancialAnswers,
  countsTowardScore,
  isCorrect,
  type CompareOptions,
  type Tolerance,
} from '../../finance/compare.js';

const EXACT: Tolerance = { kind: 'exact' };
const ONE_PERCENT: Tolerance = { kind: 'relative', value: 0.01 };

function verdict(expected: string, actual: string, options?: Partial<CompareOptions>) {
  return compareFinancialAnswers(expected, actual, { tolerance: EXACT, ...options }).verdict;
}

describe('formatting must not be scored as wrongness', () => {
  // The failure mode this module exists to prevent: a model that is right, and
  // marked wrong because it wrote the number differently.
  it.each([
    ['$1.2 billion', '1,200 million'],
    ['$1.2 billion', '1200000000'],
    ['$1.2 billion', '1.2e9'],
    ['$1.2 billion', '$1.2bn'],
    ['1,200 million', '1.2 billion'],
    ['4,300', '4300'],
  ])('treats %s and %s as the same answer', (expected, actual) => {
    expect(verdict(expected, actual)).toBe('EQUIVALENT');
  });

  it('treats an accounting negative and a signed negative as equal', () => {
    expect(verdict('-4300', '(4,300)')).toBe('EQUIVALENT');
  });
});

describe('fraction units convert into one another', () => {
  it.each([
    ['12.5%', '1250 bps'],
    ['12.5%', '12.5 percent'],
    ['1250 bps', '12.5%'],
    ['50 bps', '0.5%'],
  ])('treats %s and %s as equal', (expected, actual) => {
    expect(verdict(expected, actual)).toBe('EQUIVALENT');
  });

  it('lets a bare number stand in for the expected fraction unit', () => {
    // "0.125" is only meaningful once the task says the answer is a ratio.
    const c = compareFinancialAnswers('12.5%', '0.125', { tolerance: EXACT });
    expect(c.verdict).toBe('EQUIVALENT');
    expect(c.unitAssumed).toBe(true);
  });

  it('does not flag an assumption when the answer stated its unit', () => {
    expect(
      compareFinancialAnswers('12.5%', '1250 bps', { tolerance: EXACT }).unitAssumed,
    ).toBeUndefined();
  });

  it('refuses the bare number when the task requires an explicit unit', () => {
    // A task that asks "in basis points" is testing the unit, so supplying a
    // bare number is not a right answer written differently.
    expect(verdict('12.5%', '0.125', { requireExplicitUnit: true })).toBe('INCOMPARABLE_UNITS');
  });
});

describe('a rate is not an absolute quantity', () => {
  it('refuses to compare a percentage against a plain count', () => {
    const c = compareFinancialAnswers('1200', '12.5%', { tolerance: EXACT });
    expect(c.verdict).toBe('INCOMPARABLE_UNITS');
    expect(c.reason).toMatch(/absolute|rate/);
  });

  it('is symmetric about which side carries the unit', () => {
    expect(verdict('12.5%', '1200')).not.toBe('EQUIVALENT');
  });

  it('does not silently read 12.5 as 12.5% when the expected value is absolute', () => {
    expect(verdict('12.5%', '12.5', { requireExplicitUnit: true })).toBe('INCOMPARABLE_UNITS');
  });
});

describe('currency', () => {
  it('refuses to compare across currencies', () => {
    // Converting would need an exchange rate, and inventing one to award a
    // point is exactly the fabrication this codebase forbids.
    const c = compareFinancialAnswers('€1.2 billion', '$1.2 billion', { tolerance: EXACT });
    expect(c.verdict).toBe('INCOMPARABLE_CURRENCY');
    expect(c.reason).toMatch(/exchange rate/);
  });

  it('accepts an answer that omits the currency by default', () => {
    expect(verdict('$1.2 billion', '1200000000')).toBe('EQUIVALENT');
  });

  it('refuses an answer that omits the currency when the task requires it', () => {
    expect(verdict('$1.2 billion', '1200000000', { requireCurrency: true })).toBe(
      'INCOMPARABLE_CURRENCY',
    );
  });

  it('accepts matching currencies', () => {
    expect(verdict('€1.2 billion', '€1,200 million')).toBe('EQUIVALENT');
  });
});

describe('tolerance is the task’s choice, never a global constant', () => {
  it('rejects a rounded answer under an exact tolerance', () => {
    expect(verdict('1234.56', '1235')).toBe('DIFFERENT');
  });

  it('accepts the same pair under a one percent relative tolerance', () => {
    expect(verdict('1234.56', '1235', { tolerance: ONE_PERCENT })).toBe('EQUIVALENT');
  });

  it('accepts within an absolute tolerance', () => {
    expect(verdict('1000', '1002', { tolerance: { kind: 'absolute', value: 5 } })).toBe(
      'EQUIVALENT',
    );
  });

  it('rejects just outside an absolute tolerance', () => {
    expect(verdict('1000', '1006', { tolerance: { kind: 'absolute', value: 5 } })).toBe(
      'DIFFERENT',
    );
  });

  it('applies significant figures the way a filing reports them', () => {
    expect(
      verdict('1234567', '1230000', { tolerance: { kind: 'significantFigures', digits: 3 } }),
    ).toBe('EQUIVALENT');
  });

  it('distinguishes numbers that differ within the reported significant figures', () => {
    expect(
      verdict('1234567', '1250000', { tolerance: { kind: 'significantFigures', digits: 3 } }),
    ).toBe('DIFFERENT');
  });

  it('does not accept everything when the expected value is zero', () => {
    // A relative tolerance around zero is undefined; dividing would make any
    // answer correct.
    expect(verdict('0', '500', { tolerance: ONE_PERCENT })).toBe('DIFFERENT');
  });

  it('accepts zero against zero under a relative tolerance', () => {
    expect(verdict('0', '0', { tolerance: ONE_PERCENT })).toBe('EQUIVALENT');
  });

  it('shows how large the miss was', () => {
    const c = compareFinancialAnswers('1000', '1100', { tolerance: EXACT });
    expect(c.difference).toBe(100);
    expect(c.relativeDifference).toBeCloseTo(0.1, 10);
    expect(c.reason).toMatch(/10\.00%/);
  });
});

describe('unreadable answers are not wrong answers', () => {
  it.each(['N/A', 'not disclosed', '', 'between 1 and 2 billion'])(
    'reports %s as unparseable rather than different',
    (answer) => {
      expect(verdict('1.2 billion', answer)).toBe('UNPARSEABLE');
    },
  );

  it('does not count an unparseable answer as correct', () => {
    expect(isCorrect('UNPARSEABLE')).toBe(false);
  });

  it('still counts an unparseable model answer towards the score', () => {
    // The model failed to produce a readable answer, which is a real failure.
    const c = compareFinancialAnswers('1.2 billion', 'N/A', { tolerance: EXACT });
    expect(countsTowardScore(c)).toBe(true);
  });

  it('blames the task, not the model, when the expected answer is unreadable', () => {
    const c = compareFinancialAnswers('N/A', '1.2 billion', { tolerance: EXACT });
    expect(c.verdict).toBe('UNPARSEABLE');
    expect(c.reason).toMatch(/task-authoring error/);
  });

  it('excludes a broken task from scoring entirely', () => {
    // Otherwise one malformed task marks every model wrong and drags the whole
    // leaderboard down by the same amount, invisibly.
    const c = compareFinancialAnswers('N/A', '1.2 billion', { tolerance: EXACT });
    expect(countsTowardScore(c)).toBe(false);
  });
});

describe('only EQUIVALENT scores as correct', () => {
  it.each(['DIFFERENT', 'UNPARSEABLE', 'INCOMPARABLE_UNITS', 'INCOMPARABLE_CURRENCY'] as const)(
    'does not score %s as correct',
    (v) => {
      expect(isCorrect(v)).toBe(false);
    },
  );

  it('scores EQUIVALENT as correct', () => {
    expect(isCorrect('EQUIVALENT')).toBe(true);
  });
});

describe('every verdict carries a reason', () => {
  it.each([
    ['1.2 billion', '1.2 billion'],
    ['1.2 billion', '1.3 billion'],
    ['1.2 billion', 'N/A'],
    ['1200', '12.5%'],
    ['€500', '$500'],
  ])('explains the comparison of %s and %s', (expected, actual) => {
    const c = compareFinancialAnswers(expected, actual, { tolerance: EXACT });
    expect(c.reason.length).toBeGreaterThan(10);
  });
});

describe('locale is carried through to parsing', () => {
  it('reads both sides under the declared convention', () => {
    expect(verdict('1.200', '1200', { locale: 'eu' })).toBe('EQUIVALENT');
  });

  it('reads the same pair differently under the other convention', () => {
    expect(verdict('1.200', '1200', { locale: 'en' })).toBe('DIFFERENT');
  });
});

describe('a bare answer against a fraction is ambiguous, so the task decides', () => {
  // Against an expected "12.5%", both "0.125" and "12.5" are defensible
  // answers. Hardcoding either reading would mark the other half of correct
  // answers wrong, so the task declares which it means.
  it('reads a bare number as a ratio by default', () => {
    expect(verdict('12.5%', '0.125')).toBe('EQUIVALENT');
    expect(verdict('12.5%', '12.5')).toBe('DIFFERENT');
  });

  it('reads a bare number as a percentage when the task says so', () => {
    const asPercent = { bareNumberUnit: 'percent' } as const;
    expect(verdict('12.5%', '12.5', asPercent)).toBe('EQUIVALENT');
    expect(verdict('12.5%', '0.125', asPercent)).toBe('DIFFERENT');
  });

  it('reads a bare number as basis points when the task says so', () => {
    expect(verdict('12.5%', '1250', { bareNumberUnit: 'bps' })).toBe('EQUIVALENT');
  });

  it('names both the assumed unit and the expected one in the reason', () => {
    // A reader who disagrees with the assumption must be able to see it was
    // made, and what it was made against.
    const c = compareFinancialAnswers('12.5%', '0.125', { tolerance: EXACT });
    expect(c.reason).toMatch(/ratio/);
    expect(c.reason).toMatch(/percent/);
  });

  it('does not apply the assumption when the expected answer is absolute', () => {
    // bareNumberUnit governs fraction answers only; it must not rescale a
    // count of dollars.
    expect(verdict('1200', '1200', { bareNumberUnit: 'percent' })).toBe('EQUIVALENT');
  });
});
