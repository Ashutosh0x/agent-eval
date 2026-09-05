/**
 * Equivalence between a expected finance answer and a model's answer.
 *
 * The verdict is deliberately not a boolean. "The model was wrong", "the model
 * answered in a different unit" and "the model's answer could not be read" are
 * three different facts, and a benchmark that reports them as one number
 * cannot tell a weak model from an unusually formatted one.
 *
 * Tolerance is always supplied by the task. There is no module-level epsilon,
 * because plus or minus 0.01 is right for a current ratio and absurd for a
 * market capitalisation.
 */

import {
  isFractionUnit,
  parseFinancialNumber,
  type NumberLocale,
  type ParsedNumber,
  type ParseResult,
  type Unit,
} from './numeric.js';

export type Verdict =
  | 'EQUIVALENT'
  | 'DIFFERENT'
  | 'UNPARSEABLE'
  | 'INCOMPARABLE_UNITS'
  | 'INCOMPARABLE_CURRENCY';

/**
 * How close counts as equal.
 *
 * `exact` compares the decoded values with no slack at all, which is right for
 * share counts and integer answers. `absolute` is right for a quantity whose
 * rounding is stated in the filing. `relative` is right for anything derived,
 * where the model may have carried a different number of intermediate digits.
 * `significantFigures` is right when the filing itself only reports so many.
 */
export type Tolerance =
  | { readonly kind: 'exact' }
  | { readonly kind: 'absolute'; readonly value: number }
  | { readonly kind: 'relative'; readonly value: number }
  | { readonly kind: 'significantFigures'; readonly digits: number };

export interface CompareOptions {
  readonly tolerance: Tolerance;
  readonly locale?: NumberLocale;
  /**
   * When true, an answer with no explicit unit marker cannot match an expected
   * answer that has one. Set this when the unit is part of what is being
   * tested, e.g. a task that asks for a figure "in basis points".
   */
  readonly requireExplicitUnit?: boolean;
  /**
   * When true, an answer that omits the currency cannot match. Set this on
   * multi-currency tasks, where "1.2 billion" is genuinely under-specified.
   */
  readonly requireCurrency?: boolean;
  /**
   * How to read an answer that carries no unit marker, when the expected
   * answer is a fraction. Against an expected "12.5%", `ratio` accepts
   * "0.125" and `percent` accepts "12.5". Defaults to `ratio`.
   */
  readonly bareNumberUnit?: Extract<Unit, 'percent' | 'bps' | 'ratio'>;
}

export interface Comparison {
  readonly verdict: Verdict;
  /** Human-readable statement of why, generated from the values themselves. */
  readonly reason: string;
  readonly expected?: ParsedNumber;
  readonly actual?: ParsedNumber;
  /** Signed difference in the comparison space, when one could be computed. */
  readonly difference?: number;
  /** Relative difference against the expected magnitude, when defined. */
  readonly relativeDifference?: number;
  /** True when the answer carried no unit and the expected unit was assumed. */
  readonly unitAssumed?: boolean;
}

/** Convert a fraction-family quantity into a plain ratio. */
function toRatio(value: number, unit: Unit): number {
  if (unit === 'percent') return value / 100;
  if (unit === 'bps') return value / 10_000;
  return value;
}

function describeUnit(n: ParsedNumber): string {
  if (!n.unitExplicit) return 'no unit';
  return n.unit;
}

/**
 * Round to a number of significant figures, for `significantFigures` tolerance.
 */
function toSignificantFigures(value: number, digits: number): number {
  if (value === 0) return 0;
  const magnitude = Math.ceil(Math.log10(Math.abs(value)));
  const factor = 10 ** (digits - magnitude);
  return Math.round(value * factor) / factor;
}

/**
 * Compare two already-parsed quantities.
 *
 * Exposed separately from the string entry point so a caller that has already
 * parsed (a repeated run over the same expected answer, say) does not re-parse.
 */
export function compareParsed(
  expected: ParsedNumber,
  actual: ParsedNumber,
  options: CompareOptions,
): Comparison {
  const {
    tolerance,
    requireExplicitUnit = false,
    requireCurrency = false,
    bareNumberUnit = 'ratio',
  } = options;

  // --- currency ---------------------------------------------------------
  if (expected.currency !== undefined && actual.currency !== undefined) {
    if (expected.currency !== actual.currency) {
      return {
        verdict: 'INCOMPARABLE_CURRENCY',
        reason:
          `expected ${expected.currency} but the answer is in ${actual.currency}; ` +
          `converting between them would require an exchange rate the task does not supply`,
        expected,
        actual,
      };
    }
  } else if (requireCurrency && expected.currency !== undefined && actual.currency === undefined) {
    return {
      verdict: 'INCOMPARABLE_CURRENCY',
      reason: `the task requires an explicit currency and the answer omits one (expected ${expected.currency})`,
      expected,
      actual,
    };
  }

  // --- units ------------------------------------------------------------
  let unitAssumed = false;
  let expectedComparable: number;
  let actualComparable: number;

  const expectedIsFraction = isFractionUnit(expected.unit);
  const actualIsFraction = isFractionUnit(actual.unit);

  const mismatch = (): Comparison => ({
    verdict: 'INCOMPARABLE_UNITS',
    reason:
      `expected ${describeUnit(expected)} but the answer is ${describeUnit(actual)}; ` +
      `a rate and an absolute quantity are not the same kind of number`,
    expected,
    actual,
  });

  if (expected.unitExplicit && actual.unitExplicit) {
    if (expectedIsFraction !== actualIsFraction) return mismatch();
  } else if (expected.unitExplicit && !actual.unitExplicit) {
    if (requireExplicitUnit) {
      return {
        verdict: 'INCOMPARABLE_UNITS',
        reason:
          `the task requires the unit to be stated; expected ${expected.unit} and the ` +
          `answer gives a bare number`,
        expected,
        actual,
      };
    }
    unitAssumed = true;
  } else if (!expected.unitExplicit && actual.unitExplicit) {
    // The answer asserts a unit the task never asked for. Answering "12.5%" to
    // a question whose answer is a count of dollars is a unit error, and
    // reporting it as an ordinary wrong number hides what the model did.
    if (expectedIsFraction !== actualIsFraction) return mismatch();
  }

  if (expectedIsFraction) {
    // Percent, basis points and a plain ratio all live in fraction space and
    // convert into one another exactly.
    //
    // A bare answer is genuinely ambiguous here: against an expected "12.5%",
    // the answer "0.125" is the ratio and "12.5" is the percentage, and both
    // readings are defensible. The task declares which it means via
    // `bareNumberUnit` rather than this module picking one silently, because
    // whichever it picked would mark half of all correct answers wrong.
    expectedComparable = toRatio(expected.value, expected.unit);
    actualComparable = toRatio(actual.value, actual.unitExplicit ? actual.unit : bareNumberUnit);
  } else {
    expectedComparable = expected.value;
    actualComparable = actual.value;
  }

  // --- magnitude --------------------------------------------------------
  const difference = actualComparable - expectedComparable;
  const relativeDifference =
    expectedComparable === 0 ? undefined : Math.abs(difference / expectedComparable);

  const equal = withinTolerance(expectedComparable, actualComparable, tolerance);

  const base = {
    expected,
    actual,
    difference,
    ...(relativeDifference !== undefined ? { relativeDifference } : {}),
    ...(unitAssumed ? { unitAssumed: true } : {}),
  };

  if (equal) {
    return {
      verdict: 'EQUIVALENT',
      reason: unitAssumed
        ? `equal within tolerance; the answer carried no unit and was read as a ` +
          `${bareNumberUnit} against an expected ${expected.unit}`
        : 'equal within tolerance',
      ...base,
    };
  }

  return {
    verdict: 'DIFFERENT',
    reason:
      `expected ${expectedComparable} but the answer resolves to ${actualComparable}` +
      (relativeDifference !== undefined
        ? ` (off by ${(relativeDifference * 100).toFixed(2)}%)`
        : ''),
    ...base,
  };
}

function withinTolerance(expected: number, actual: number, tolerance: Tolerance): boolean {
  switch (tolerance.kind) {
    case 'exact':
      return expected === actual;
    case 'absolute':
      return Math.abs(actual - expected) <= tolerance.value;
    case 'relative': {
      if (expected === 0) {
        // A relative tolerance around zero is undefined, so fall back to
        // requiring exactness rather than dividing by zero and accepting all.
        return actual === 0;
      }
      return Math.abs((actual - expected) / expected) <= tolerance.value;
    }
    case 'significantFigures':
      return (
        toSignificantFigures(expected, tolerance.digits) ===
        toSignificantFigures(actual, tolerance.digits)
      );
  }
}

/**
 * Compare an expected answer against a model's answer, both as written.
 *
 * An unreadable expected answer is a task-authoring bug and is reported
 * distinctly from an unreadable model answer, so a broken task cannot quietly
 * present as every model failing it.
 */
export function compareFinancialAnswers(
  expectedText: string,
  actualText: string,
  options: CompareOptions,
): Comparison {
  const parseOptions = options.locale !== undefined ? { locale: options.locale } : {};
  const expected: ParseResult = parseFinancialNumber(expectedText, parseOptions);
  const actual: ParseResult = parseFinancialNumber(actualText, parseOptions);

  if (!expected.ok) {
    return {
      verdict: 'UNPARSEABLE',
      reason: `the expected answer could not be parsed (${expected.reason}: ${expected.detail}); this is a task-authoring error, not a model error`,
    };
  }

  if (!actual.ok) {
    return {
      verdict: 'UNPARSEABLE',
      reason: `the answer could not be parsed (${actual.reason}: ${actual.detail})`,
      expected,
    };
  }

  return compareParsed(expected, actual, options);
}

/** Whether a verdict should count towards the numerator of an accuracy score. */
export function isCorrect(verdict: Verdict): boolean {
  return verdict === 'EQUIVALENT';
}

/**
 * Whether a verdict says something about the model at all.
 *
 * An unparseable EXPECTED answer says something about the task, and such a
 * result must be excluded from scoring rather than counted as a failure.
 */
export function countsTowardScore(comparison: Comparison): boolean {
  if (comparison.verdict !== 'UNPARSEABLE') return true;
  // Expected parsed, so the unreadable side was the model's.
  return comparison.expected !== undefined;
}

export { describeUnit };
