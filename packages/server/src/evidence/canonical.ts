/**
 * Deterministic JSON serialization, for anything that gets hashed or signed.
 *
 * `JSON.stringify` preserves insertion order, so two objects that are equal by
 * every reasonable definition serialize differently:
 *
 *   JSON.stringify({ a: 1, b: 2 })  !==  JSON.stringify({ b: 2, a: 1 })
 *
 * Hash either one and you get a different digest. That is invisible until a
 * value crosses a boundary that reorders keys -- a database round-trip, a
 * different driver, a JSON column, an object rebuilt from a spread -- and then
 * a hash chain fails to verify against data nobody touched. The log looks
 * tampered with when the only thing that changed was key order.
 *
 * So: sort object keys, recursively, before hashing. Following RFC 8785 (JSON
 * Canonicalization Scheme) in the parts that matter here.
 *
 * Rejected outright rather than silently mangled:
 *
 *   undefined     JSON.stringify drops it from objects but renders it as null
 *                 inside arrays, so the same value hashes two ways
 *   NaN, Infinity JSON.stringify emits null, collapsing distinct values
 *   -0            serializes as 0, so it cannot round-trip
 *   BigInt        JSON.stringify throws; caught here with a clearer message
 *   cycles        would recurse forever
 *
 * An audit record that cannot be represented exactly should fail loudly at the
 * point of writing, not hash to something that does not mean what it says.
 */

export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalizationError';
  }
}

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Serialize a value to canonical JSON: object keys sorted by code unit,
 * no insignificant whitespace, and no lossy values.
 */
export function canonicalize(value: unknown): string {
  return write(value, '$', new Set());
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`${value} cannot be represented in JSON`, path);
      }
      if (Object.is(value, -0)) {
        throw new CanonicalizationError('-0 does not round-trip through JSON', path);
      }
      return JSON.stringify(value);
    }

    case 'string':
      return JSON.stringify(value);

    case 'bigint':
      throw new CanonicalizationError('bigint is not valid JSON; format it as a string', path);

    case 'undefined':
      throw new CanonicalizationError('undefined is not valid JSON', path);

    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`${typeof value} cannot be serialized`, path);
  }

  // Objects and arrays.
  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError('circular reference', path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((v, i) => write(v, `${path}[${i}]`, seen));
      return `[${items.join(',')}]`;
    }

    // Dates are common in audit payloads and have a defined JSON form, but
    // relying on JSON.stringify's implicit toJSON would hide the conversion.
    if (obj instanceof Date) {
      if (Number.isNaN(obj.getTime())) {
        throw new CanonicalizationError('invalid Date', path);
      }
      return JSON.stringify(obj.toISOString());
    }

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      // Match JSON.stringify: an undefined property is absent, not null. This
      // is the one lossy case allowed, because it is the universal convention
      // and rejecting it would make ordinary optional fields unusable.
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${write(v, `${path}.${key}`, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
