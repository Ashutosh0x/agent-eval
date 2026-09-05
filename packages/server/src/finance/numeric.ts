/**
 * Financial number parsing and equivalence.
 *
 * A finance evaluator lives or dies here. If it cannot decide that
 * "$1.2 billion", "1,200 million" and "1200000000" are the same answer, every
 * category score above it is noise, and a model is marked wrong for formatting.
 *
 * Two design choices drive the whole module.
 *
 * First, parsing never returns a bare float. A float has already lost the
 * currency, the unit and the scale, which are exactly the facts needed to
 * decide equivalence. "12.5" and "12.5%" are the same float and different
 * answers.
 *
 * Second, a number this module cannot parse is a ParseFailure, never a guess.
 * "Could not read the answer" and "the answer was wrong" are different facts
 * about a model, and collapsing them inflates the error rate of any model that
 * formats unusually.
 */

/** What kind of quantity a number denotes. */
export type Unit = 'absolute' | 'percent' | 'bps' | 'ratio';

/**
 * Units that all denote a dimensionless fraction, and so are inter-convertible.
 * `absolute` is deliberately not a member: a count of dollars is not a rate.
 */
const FRACTION_UNITS: readonly Unit[] = ['percent', 'bps', 'ratio'];

export function isFractionUnit(unit: Unit): boolean {
  return FRACTION_UNITS.includes(unit);
}

export type SignConvention = 'none' | 'explicit' | 'parenthetical';

export type ParseFailureReason =
  | 'EMPTY'
  | 'NO_DIGITS'
  | 'MALFORMED_GROUPING'
  | 'AMBIGUOUS_SEPARATOR'
  | 'MULTIPLE_CURRENCIES'
  | 'MULTIPLE_SCALES'
  | 'UNPARSEABLE';

export interface ParsedNumber {
  readonly ok: true;
  /** Magnitude with the scale word already applied, in the stated `unit`. */
  readonly value: number;
  readonly raw: string;
  /** ISO code where determinable. Absent when the text carried no currency. */
  readonly currency?: string;
  /**
   * True when the symbol used maps to more than one real currency, e.g. "$".
   * The code is then filled in by convention, and this flag says so.
   */
  readonly currencyAmbiguous?: boolean;
  readonly unit: Unit;
  /** True when `unit` came from an explicit marker rather than a default. */
  readonly unitExplicit: boolean;
  /** The multiplier the scale word contributed; 1 when there was none. */
  readonly scale: number;
  readonly scaleWord?: string;
  readonly negative: boolean;
  readonly signConvention: SignConvention;
  /** Decimal places as written, which a tolerance can be derived from. */
  readonly precision: number;
}

export interface ParseFailure {
  readonly ok: false;
  readonly reason: ParseFailureReason;
  readonly raw: string;
  readonly detail: string;
}

export type ParseResult = ParsedNumber | ParseFailure;

/**
 * Which convention the digits are written in.
 *
 * `en` treats "," as a group separator and "." as the decimal point; `eu` is
 * the reverse. There is no autodetect default, because guessing the locale
 * from the digits is how "1.200" silently becomes 1200.
 */
export type NumberLocale = 'en' | 'eu';

export interface ParseOptions {
  readonly locale?: NumberLocale;
  /** Unit assumed when the text carries no explicit marker. */
  readonly defaultUnit?: Unit;
}

const SCALE_WORDS: ReadonlyArray<readonly [string, number]> = [
  // Longest first: "trillion" must win before "t" can match its tail.
  ['trillion', 1e12],
  ['billion', 1e9],
  ['million', 1e6],
  ['thousand', 1e3],
  ['crore', 1e7],
  ['lakh', 1e5],
  ['lac', 1e5],
  ['tn', 1e12],
  ['bn', 1e9],
  ['mm', 1e6],
  ['mn', 1e6],
  ['k', 1e3],
  ['b', 1e9],
  ['m', 1e6],
  ['t', 1e12],
];

/**
 * Alternation of every scale word, longest first so that "million" is matched
 * before the "m" alternative can claim its first letter.
 */
const SCALE_ALTERNATION = SCALE_WORDS.map(([word]) => word).join('|');

/** A scale word attached to digits, immediately followed by another one. */
const CHAINED_SCALES = new RegExp(
  `[0-9]\\s*(?:${SCALE_ALTERNATION})s?\\s+(?:${SCALE_ALTERNATION})s?(?![a-z0-9])`,
  'i',
);

/**
 * Symbols that denote exactly one currency, and symbols that do not.
 *
 * "$" is used by more than a dozen currencies. Resolving it to USD is a
 * convention, and `currencyAmbiguous` records that a convention was applied
 * rather than a fact read off the page.
 */
const UNAMBIGUOUS_SYMBOLS: Readonly<Record<string, string>> = {
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  '₺': 'TRY',
  '₪': 'ILS',
};

const AMBIGUOUS_SYMBOLS: Readonly<Record<string, string>> = {
  $: 'USD',
};

/** Three-letter codes recognised when written out, e.g. "1.2 billion USD". */
const CURRENCY_CODE =
  /(^|[^A-Z])(USD|EUR|GBP|JPY|INR|CNY|CAD|AUD|CHF|SGD|HKD|KRW|SEK|NOK|DKK|NZD|ZAR|BRL|MXN|RUB|TRY|AED|SAR)([^A-Z]|$)/i;

/**
 * Parse a financial quantity out of free text.
 *
 * Returns a discriminated result rather than throwing, because an unparseable
 * answer is an ordinary evaluation outcome, not an exceptional one.
 */
export function parseFinancialNumber(input: string, options: ParseOptions = {}): ParseResult {
  const locale = options.locale ?? 'en';
  const raw = input;

  const fail = (reason: ParseFailureReason, detail: string): ParseFailure => ({
    ok: false,
    reason,
    raw,
    detail,
  });

  if (typeof input !== 'string') return fail('UNPARSEABLE', 'input was not a string');

  let text = input.trim();
  if (text === '') return fail('EMPTY', 'input was empty or whitespace only');
  if (!/[0-9]/.test(text)) {
    return fail('NO_DIGITS', 'no digits present, so there is nothing to parse');
  }

  // Normalise unicode variants that appear in filings and in model output.
  text = text
    .replace(/−/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/[‘’‛]/g, "'");

  // Expand scientific notation before anything strips the exponent letter.
  // Left in place, "1.2e9" reaches the digit scan as two separate numbers and
  // is refused, which would fail every model that answers in that form.
  text = text.replace(/([0-9]+(?:\.[0-9]+)?)[eE]([+-]?[0-9]+)/g, (whole, mantissa, exponent) => {
    const expanded = Number(mantissa) * 10 ** Number(exponent);
    // Round-tripping through String can itself produce exponent notation for
    // very large or very small magnitudes; leaving the original alone is
    // better than substituting a form the digit scan also cannot read.
    return Number.isFinite(expanded) && !String(expanded).includes('e')
      ? String(expanded)
      : whole;
  });

  // Two scale words in a row ("1 million billion") is not a quantity. The
  // scale loop below would consume the first and discard the second as
  // commentary, silently returning a number a thousandfold too small.
  if (CHAINED_SCALES.test(text)) {
    return fail('MULTIPLE_SCALES', 'two scale words are chained together; this is not a quantity');
  }

  // --- sign -------------------------------------------------------------
  let negative = false;
  let signConvention: SignConvention = 'none';

  // Accounting parentheses, checked before the minus so that "(4,300)" is
  // recognised even when a stray sign sits inside.
  const parenthesised = /^\(\s*(.*?)\s*\)$/.exec(text);
  if (parenthesised) {
    negative = true;
    signConvention = 'parenthetical';
    text = parenthesised[1]!;
  }

  // A currency symbol may sit either side of the sign: "-$5" and "$-5".
  const hasMinus = /(^|[^0-9])-\s*[0-9$€£¥₹.]/.test(text);
  if (hasMinus) {
    if (signConvention === 'parenthetical') {
      // "(-4,300)" double-negates. That is a formatting error rather than a
      // positive number, so refuse instead of picking a reading.
      return fail('UNPARSEABLE', 'both parentheses and an explicit minus sign are present');
    }
    negative = true;
    signConvention = 'explicit';
    text = text.replace('-', ' ');
  } else if (/(^|[^0-9])\+\s*[0-9$]/.test(text)) {
    signConvention = 'explicit';
    text = text.replace('+', ' ');
  }

  // --- currency ---------------------------------------------------------
  let currency: string | undefined;
  let currencyAmbiguous = false;
  const currenciesFound = new Set<string>();

  for (const [symbol, code] of Object.entries(UNAMBIGUOUS_SYMBOLS)) {
    if (text.includes(symbol)) {
      currenciesFound.add(code);
      currency = code;
      text = text.split(symbol).join(' ');
    }
  }
  for (const [symbol, code] of Object.entries(AMBIGUOUS_SYMBOLS)) {
    if (text.includes(symbol)) {
      currenciesFound.add(code);
      currency = code;
      currencyAmbiguous = true;
      text = text.split(symbol).join(' ');
    }
  }

  const codeMatch = CURRENCY_CODE.exec(text);
  if (codeMatch) {
    const code = codeMatch[2]!.toUpperCase();
    // A written code outranks a symbol, so "US$ 5" is USD rather than a
    // conflict. A genuine conflict is caught by the set size below.
    if (!(currencyAmbiguous && code === currency)) currenciesFound.add(code);
    currency = code;
    currencyAmbiguous = false;
    text = text.replace(CURRENCY_CODE, '$1 $3');
  }

  if (currenciesFound.size > 1) {
    return fail(
      'MULTIPLE_CURRENCIES',
      `found ${[...currenciesFound].sort().join(' and ')}; one quantity cannot be in two currencies`,
    );
  }

  // Drop a country qualifier left behind by forms such as "US$" or "C$".
  text = text.replace(/(^|\s)(US|C|A|NZ|HK|S|R)\s*(?=[0-9])/i, ' ');

  // --- unit -------------------------------------------------------------
  let unit: Unit = options.defaultUnit ?? 'absolute';
  let unitExplicit = false;

  if (/basis\s*points?|bps|bp(?![a-z])/i.test(text)) {
    unit = 'bps';
    unitExplicit = true;
    text = text.replace(/basis\s*points?|bps|bp(?![a-z])/gi, ' ');
  } else if (/%|percentage\s*points?|percent(age)?|pct/i.test(text)) {
    unit = 'percent';
    unitExplicit = true;
    text = text.replace(/%|percentage\s*points?|percent(age)?|pct/gi, ' ');
  }

  // --- scale ------------------------------------------------------------
  let scale = 1;
  let scaleWord: string | undefined;
  const scalesFound: string[] = [];

  for (const [word, factor] of SCALE_WORDS) {
    // A scale word must follow a digit, optionally across a space, and must
    // end its token. That keeps the "m" in a word and a stray ticker letter
    // from being read as a multiplier.
    const pattern = new RegExp(`([0-9])\\s*${word}s?(?![a-z0-9])`, 'i');
    if (pattern.test(text)) {
      scalesFound.push(word);
      if (scaleWord === undefined) {
        scale = factor;
        scaleWord = word;
      }
      text = text.replace(pattern, '$1 ');
    }
  }

  if (scalesFound.length > 1) {
    return fail('MULTIPLE_SCALES', `found scale words ${scalesFound.join(' and ')}; only one may apply`);
  }

  // --- digits -----------------------------------------------------------
  // Anything left that is not a digit or a separator is commentary
  // ("approximately", "revenue of"). Dropping it is safe only here, after
  // every semantic marker above has been consumed.
  const digitPart = text.replace(/[^0-9.,'\s]/g, ' ').trim();
  const tokens = digitPart.split(/\s+/).filter((t) => /[0-9]/.test(t));

  if (tokens.length === 0) return fail('NO_DIGITS', 'no numeric token remained after parsing');
  if (tokens.length > 1) {
    return fail(
      'UNPARSEABLE',
      `found ${tokens.length} separate numbers (${tokens.join(', ')}); expected exactly one`,
    );
  }

  const decoded = decodeDigits(tokens[0]!, locale);
  if (!decoded.ok) return fail(decoded.reason, decoded.detail);

  const magnitude = decoded.value * scale;

  return {
    ok: true,
    value: negative ? -magnitude : magnitude,
    raw,
    ...(currency !== undefined ? { currency } : {}),
    ...(currencyAmbiguous ? { currencyAmbiguous: true } : {}),
    unit,
    unitExplicit,
    scale,
    ...(scaleWord !== undefined ? { scaleWord } : {}),
    negative,
    signConvention,
    precision: decoded.precision,
  };
}

interface DigitsOk {
  ok: true;
  value: number;
  precision: number;
}
interface DigitsFail {
  ok: false;
  reason: ParseFailureReason;
  detail: string;
}

/**
 * Turn a grouped digit string into a number under a declared locale.
 *
 * The hard case is a single separator followed by exactly three digits:
 * "1,200" is twelve hundred under `en` and 1.2 under `eu`. Both readings are
 * legitimate, so this resolves by declared locale and never by frequency.
 */
function decodeDigits(token: string, locale: NumberLocale): DigitsOk | DigitsFail {
  const groupSep = locale === 'en' ? ',' : '.';
  const decimalSep = locale === 'en' ? '.' : ',';

  // Apostrophe grouping (Swiss usage) is unambiguous, so it is always a group.
  let t = token.replace(/'/g, '');

  const groupCount = t.split(groupSep).length - 1;
  const decimalCount = t.split(decimalSep).length - 1;

  if (decimalCount > 1) {
    return {
      ok: false,
      reason: 'MALFORMED_GROUPING',
      detail: `more than one decimal separator "${decimalSep}" in "${token}"`,
    };
  }

  if (groupCount > 0) {
    const beforeDecimal = t.split(decimalSep)[0]!;
    const groups = beforeDecimal.split(groupSep);
    const head = groups[0]!;
    const rest = groups.slice(1);

    // A group separator not separating groups of three is either a decimal
    // point in the other convention or a typo. Refusing is the only reading
    // that cannot silently change the number by a factor of a thousand.
    if (head.length === 0 || head.length > 3 || rest.some((g) => g.length !== 3)) {
      return {
        ok: false,
        reason: 'AMBIGUOUS_SEPARATOR',
        detail:
          `"${token}" does not group in threes under the ${locale} convention, so ` +
          `"${groupSep}" may be a decimal separator here. Declare the locale explicitly.`,
      };
    }
    t = t.split(groupSep).join('');
  }

  const normalised = locale === 'en' ? t : t.replace(',', '.');
  const value = Number(normalised);

  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'UNPARSEABLE', detail: `"${token}" is not a finite number` };
  }

  const decimalPart = normalised.split('.')[1];
  return { ok: true, value, precision: decimalPart ? decimalPart.length : 0 };
}
