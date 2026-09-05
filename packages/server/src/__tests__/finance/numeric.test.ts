import { describe, it, expect } from 'vitest';
import {
  isFractionUnit,
  parseFinancialNumber,
  type ParsedNumber,
} from '../../finance/numeric.js';

/** Parse and assert success, so each test can read the fields directly. */
function ok(input: string, options?: Parameters<typeof parseFinancialNumber>[1]): ParsedNumber {
  const r = parseFinancialNumber(input, options);
  if (!r.ok) throw new Error(`expected "${input}" to parse, got ${r.reason}: ${r.detail}`);
  return r;
}

function bad(input: string, options?: Parameters<typeof parseFinancialNumber>[1]) {
  const r = parseFinancialNumber(input, options);
  if (r.ok) throw new Error(`expected "${input}" to fail, got ${r.value}`);
  return r;
}

describe('the equivalence class the whole evaluator rests on', () => {
  // If these five do not agree, a model is marked wrong for formatting.
  const onePointTwoBillion = [
    '$1.2 billion',
    '1,200 million',
    '1200000000',
    '1.2e9',
    '1.2bn',
  ];

  it.each(onePointTwoBillion)('reads %s as 1.2e9', (input) => {
    expect(ok(input).value).toBe(1_200_000_000);
  });

  it('reads all five to exactly the same value', () => {
    const values = new Set(onePointTwoBillion.map((s) => ok(s).value));
    expect(values.size).toBe(1);
  });
});

describe('scale words', () => {
  it.each([
    ['1 thousand', 1e3],
    ['1k', 1e3],
    ['1 million', 1e6],
    ['1mn', 1e6],
    ['1mm', 1e6],
    ['1m', 1e6],
    ['1 billion', 1e9],
    ['1bn', 1e9],
    ['1b', 1e9],
    ['1 trillion', 1e12],
    ['1tn', 1e12],
    ['1t', 1e12],
  ])('applies %s', (input, expected) => {
    expect(ok(input).value).toBe(expected);
  });

  it.each([
    ['1 lakh', 1e5],
    ['1 crore', 1e7],
    ['2.5 crore', 2.5e7],
  ])('supports the Indian numbering system: %s', (input, expected) => {
    // Indian filings report in lakh and crore, and an evaluator that only
    // knows million and billion silently marks those answers wrong.
    expect(ok(input).value).toBe(expected);
  });

  it('accepts a plural scale word', () => {
    expect(ok('3 millions').value).toBe(3e6);
  });

  it('records the multiplier and the word that produced it', () => {
    const n = ok('4.2 billion');
    expect(n.scale).toBe(1e9);
    expect(n.scaleWord).toBe('billion');
  });

  it('reports a scale of 1 when there is no scale word', () => {
    const n = ok('4200');
    expect(n.scale).toBe(1);
    expect(n.scaleWord).toBeUndefined();
  });

  it('refuses two scale words rather than picking one', () => {
    expect(bad('1 million billion').reason).toBe('MULTIPLE_SCALES');
  });

  it('does not read a letter inside a word as a multiplier', () => {
    // "trimmed" ends in no scale word; the m is interior.
    expect(ok('5 trimmed').value).toBe(5);
  });

  it('does not read a scale word that is not attached to digits', () => {
    expect(ok('million-dollar question about 7').value).toBe(7);
  });
});

describe('accounting parentheses', () => {
  it('reads (4,300) as negative', () => {
    // The single most common finance convention, and the one a general-purpose
    // number parser always gets wrong.
    expect(ok('(4,300)').value).toBe(-4300);
  });

  it.each([
    ['(1.2 billion)', -1.2e9],
    ['($5,000)', -5000],
    ['(0.5%)', -0.5],
    ['(12)', -12],
  ])('reads %s as negative', (input, expected) => {
    expect(ok(input).value).toBe(expected);
  });

  it('records the sign convention used', () => {
    expect(ok('(4,300)').signConvention).toBe('parenthetical');
    expect(ok('-4300').signConvention).toBe('explicit');
    expect(ok('4300').signConvention).toBe('none');
  });

  it('sets the negative flag as well as the sign of the value', () => {
    expect(ok('(4,300)').negative).toBe(true);
    expect(ok('4300').negative).toBe(false);
  });

  it('refuses a doubly-negated number rather than cancelling it', () => {
    // "(-4,300)" is a formatting error. Reading it as +4300 would invent a
    // sign flip the writer never intended.
    expect(bad('(-4,300)').reason).toBe('UNPARSEABLE');
  });

  it('treats parentheses and a minus as the same magnitude', () => {
    expect(ok('(4,300)').value).toBe(ok('-4,300').value);
  });
});

describe('signs', () => {
  it.each([
    ['-4300', -4300],
    ['-$5', -5],
    ['$-5', -5],
    ['+12', 12],
    ['+$1.5 million', 1.5e6],
  ])('reads %s', (input, expected) => {
    expect(ok(input).value).toBe(expected);
  });

  it('normalises a unicode minus sign', () => {
    expect(ok('−4300').value).toBe(-4300);
  });

  it('normalises an en dash used as a minus', () => {
    expect(ok('–4300').value).toBe(-4300);
  });
});

describe('units', () => {
  it.each([
    ['12.5%', 'percent', 12.5],
    ['12.5 percent', 'percent', 12.5],
    ['12.5 pct', 'percent', 12.5],
    ['1250 bps', 'bps', 1250],
    ['1250 basis points', 'bps', 1250],
  ])('reads %s as %s', (input, unit, value) => {
    const n = ok(input);
    expect(n.unit).toBe(unit);
    expect(n.value).toBe(value);
  });

  it('marks an explicit unit as explicit', () => {
    expect(ok('12.5%').unitExplicit).toBe(true);
  });

  it('marks a bare number as having no explicit unit', () => {
    // This is the flag that lets the comparator decide whether "0.125" may
    // stand in for "12.5%", instead of the parser deciding for it.
    const n = ok('0.125');
    expect(n.unitExplicit).toBe(false);
    expect(n.unit).toBe('absolute');
  });

  it('honours a declared default unit for bare numbers', () => {
    const n = ok('0.125', { defaultUnit: 'ratio' });
    expect(n.unit).toBe('ratio');
    expect(n.unitExplicit).toBe(false);
  });

  it('does not treat a bare number as a percentage', () => {
    expect(ok('12.5').unit).toBe('absolute');
  });

  it('classifies which units are inter-convertible', () => {
    expect(isFractionUnit('percent')).toBe(true);
    expect(isFractionUnit('bps')).toBe(true);
    expect(isFractionUnit('ratio')).toBe(true);
    expect(isFractionUnit('absolute')).toBe(false);
  });

  it('reads basis points before percent, since bp is not a percent sign', () => {
    expect(ok('50 bp').unit).toBe('bps');
  });
});

describe('currency', () => {
  it.each([
    ['€1.2 billion', 'EUR'],
    ['£500', 'GBP'],
    ['¥300', 'JPY'],
    ['₹5,000', 'INR'],
    ['1.2 billion USD', 'USD'],
    ['500 eur', 'EUR'],
  ])('reads the currency of %s as %s', (input, code) => {
    expect(ok(input).currency).toBe(code);
  });

  it('resolves $ to USD but records that this is a convention', () => {
    // More than a dozen currencies use "$". Claiming USD as a fact would be a
    // fabrication; claiming it as a convention is honest.
    const n = ok('$1.2 billion');
    expect(n.currency).toBe('USD');
    expect(n.currencyAmbiguous).toBe(true);
  });

  it('does not mark an unambiguous symbol as ambiguous', () => {
    expect(ok('€500').currencyAmbiguous).toBeUndefined();
  });

  it('lets a written code resolve an ambiguous symbol', () => {
    const n = ok('$500 USD');
    expect(n.currency).toBe('USD');
    expect(n.currencyAmbiguous).toBeUndefined();
  });

  it('leaves the currency absent when the text carries none', () => {
    expect(ok('1200').currency).toBeUndefined();
  });

  it('refuses a quantity written in two currencies', () => {
    expect(bad('€500 GBP').reason).toBe('MULTIPLE_CURRENCIES');
  });

  it('handles a country-qualified dollar sign', () => {
    expect(ok('US$1.2 billion').value).toBe(1.2e9);
  });
});

describe('digit grouping', () => {
  it.each([
    ['1,200', 1200],
    ['1,200,000', 1_200_000],
    ['12,345,678', 12_345_678],
    ['999', 999],
    ['1234567', 1_234_567],
  ])('reads %s under the en convention', (input, expected) => {
    expect(ok(input).value).toBe(expected);
  });

  it('reads Swiss apostrophe grouping, which is never a decimal point', () => {
    expect(ok("1'200'000").value).toBe(1_200_000);
  });

  it('reads a European decimal comma when the locale says so', () => {
    expect(ok('1,2', { locale: 'eu' }).value).toBe(1.2);
  });

  it('reads a European thousands point when the locale says so', () => {
    expect(ok('1.200', { locale: 'eu' }).value).toBe(1200);
  });

  it('reads the same string differently under the two locales', () => {
    // This is the point of declaring the locale rather than sniffing it.
    expect(ok('1.200', { locale: 'en' }).value).toBe(1.2);
    expect(ok('1.200', { locale: 'eu' }).value).toBe(1200);
  });

  it('refuses a comma followed by two digits under the en convention', () => {
    // "1,2" cannot be en grouping. Guessing that it is European would silently
    // change the value, so it is refused with a reason that names the fix.
    const f = bad('1,2');
    expect(f.reason).toBe('AMBIGUOUS_SEPARATOR');
    expect(f.detail).toMatch(/locale/i);
  });

  it('refuses malformed grouping', () => {
    expect(bad('1,20,000').reason).toBe('AMBIGUOUS_SEPARATOR');
  });

  it('refuses more than one decimal point', () => {
    expect(bad('1.2.3').reason).toBe('MALFORMED_GROUPING');
  });
});

describe('precision is preserved so a tolerance can be derived from it', () => {
  it.each([
    ['1200', 0],
    ['1.2', 1],
    ['1.25', 2],
    ['1.2500', 4],
  ])('records %s as %i decimal places', (input, digits) => {
    expect(ok(input).precision).toBe(digits);
  });
});

describe('scientific notation', () => {
  it.each([
    ['1.2e9', 1.2e9],
    ['1.2E9', 1.2e9],
    ['5e3', 5000],
  ])('reads %s', (input, expected) => {
    expect(ok(input).value).toBe(expected);
  });
});

describe('prose around the number', () => {
  it.each([
    ['approximately 1.2 billion', 1.2e9],
    ['about $500', 500],
    ['revenue was 1,200 million', 1.2e9],
    ['roughly 12.5%', 12.5],
  ])('reads the quantity out of %s', (input, expected) => {
    expect(ok(input).value).toBe(expected);
  });

  it('refuses text containing two separate numbers', () => {
    // Silently taking the first would score a hedged answer as confident.
    const f = bad('between 1.2 and 1.5 billion');
    expect(f.reason).toBe('UNPARSEABLE');
    expect(f.detail).toMatch(/2 separate numbers/);
  });
});

describe('refusals, which must never be silent guesses', () => {
  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['N/A', 'NO_DIGITS'],
    ['not disclosed', 'NO_DIGITS'],
    ['abc', 'NO_DIGITS'],
    ['unknown', 'NO_DIGITS'],
  ])('refuses %s with reason %s', (input, reason) => {
    expect(bad(input).reason).toBe(reason);
  });

  it('never returns zero for text with no digits', () => {
    // Number("") is 0, and a parser that leans on it scores "N/A" as the
    // answer zero, which is a real number a filing might contain.
    const r = parseFinancialNumber('N/A');
    expect(r.ok).toBe(false);
  });

  it('always explains the refusal', () => {
    for (const input of ['', 'N/A', '1,2', '1.2.3', '€5 GBP']) {
      const f = bad(input);
      expect(f.detail.length).toBeGreaterThan(10);
    }
  });

  it('preserves the raw input on a refusal, for the evidence bundle', () => {
    expect(bad('N/A').raw).toBe('N/A');
  });

  it('preserves the raw input on success too', () => {
    expect(ok('$1.2 billion').raw).toBe('$1.2 billion');
  });

  it('refuses a non-string input rather than coercing it', () => {
    // A JSON answer field can arrive as a number or null.
    const r = parseFinancialNumber(null as unknown as string);
    expect(r.ok).toBe(false);
  });
});

describe('whitespace and unicode from real documents', () => {
  it('handles a non-breaking space between digits and scale', () => {
    expect(ok('1.2 billion').value).toBe(1.2e9);
  });

  it('handles a narrow no-break space, which appears in EU filings', () => {
    expect(ok('1 200 000'.replace(/ /g, '')).value).toBe(1_200_000);
  });

  it('trims surrounding whitespace', () => {
    expect(ok('  $500  ').value).toBe(500);
  });
});

describe('combinations that occur together in filings', () => {
  it('reads a negative scaled currency amount in parentheses', () => {
    const n = ok('($1.2 billion)');
    expect(n.value).toBe(-1.2e9);
    expect(n.currency).toBe('USD');
    expect(n.scale).toBe(1e9);
    expect(n.signConvention).toBe('parenthetical');
  });

  it('reads a negative percentage', () => {
    const n = ok('-3.5%');
    expect(n.value).toBe(-3.5);
    expect(n.unit).toBe('percent');
  });

  it('reads a grouped, scaled, currency-marked figure', () => {
    const n = ok('€1,200 million');
    expect(n.value).toBe(1.2e9);
    expect(n.currency).toBe('EUR');
  });
});
