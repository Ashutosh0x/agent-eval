/**
 * Signing and canonicalization.
 *
 * The canonicalization tests carry more weight than they look like they
 * should. Key ordering is the failure mode that turns a working signature
 * scheme into an intermittently-failing one months later, when a value starts
 * arriving from a database instead of memory and its keys come back in a
 * different order.
 */

import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalize } from '../../evidence/canonical.js';
import { InMemoryKeySource, Signer, verifySignature } from '../../evidence/signer.js';

describe('canonical JSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalize({ a: 1, b: 2, c: 3 })).toBe(canonicalize({ c: 3, a: 1, b: 2 }));
  });

  it('sorts nested keys too', () => {
    const x = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const y = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalize(x)).toBe(canonicalize(y));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
  });

  it('drops undefined properties, matching JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects values that would silently change meaning', () => {
    // Each of these serializes to something that is not what it was.
    expect(() => canonicalize({ n: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ n: Infinity })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ n: -0 })).toThrow(/-0/);
    expect(() => canonicalize([undefined])).toThrow(/undefined/);
    expect(() => canonicalize({ n: 1n })).toThrow(/bigint/);
  });

  it('names the path to the offending value', () => {
    try {
      canonicalize({ run: { metrics: { cost: Number.NaN } } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as CanonicalizationError).path).toBe('$.run.metrics.cost');
    }
  });

  it('rejects circular structures instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => canonicalize(a)).toThrow(/circular/);
  });

  it('serializes dates as ISO strings', () => {
    expect(canonicalize({ at: new Date(Date.UTC(2026, 0, 1)) })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
  });

  it('escapes strings so structure cannot be forged', () => {
    // A payload that tries to inject JSON syntax must not change the shape.
    const parsed = JSON.parse(canonicalize({ note: '","injected":"yes' }));
    expect(Object.keys(parsed)).toEqual(['note']);
  });
});

describe('ed25519 signing', () => {
  it('round-trips a signature', async () => {
    const key = InMemoryKeySource.generate('k1');
    const signed = await new Signer(key).sign({ run: 'r1', score: 0.82 });
    expect(verifySignature(signed, key.publicKeyPem()).valid).toBe(true);
  });

  it('records which key signed', async () => {
    const signed = await new Signer(InMemoryKeySource.generate('kms-2026-q1')).sign({ x: 1 });
    expect(signed.signature.keyId).toBe('kms-2026-q1');
    expect(signed.signature.algorithm).toBe('ed25519');
  });

  it('fails against the wrong key', async () => {
    const signed = await new Signer(InMemoryKeySource.generate()).sign({ x: 1 });
    const other = InMemoryKeySource.generate();
    const result = verifySignature(signed, other.publicKeyPem());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it('fails when the payload is altered', async () => {
    const key = InMemoryKeySource.generate();
    const signed = await new Signer(key).sign({ score: 0.82 });
    const tampered = { ...signed, payload: { score: 0.99 } };
    expect(verifySignature(tampered, key.publicKeyPem()).valid).toBe(false);
  });

  it('still verifies after key reordering', async () => {
    // The scenario canonicalization exists for: same value, different key
    // order, as a database round-trip would produce.
    const key = InMemoryKeySource.generate();
    const signed = await new Signer(key).sign({ alpha: 1, beta: 2, gamma: 3 });
    const reordered = {
      ...signed,
      payload: { gamma: 3, alpha: 1, beta: 2 },
    };
    expect(verifySignature(reordered, key.publicKeyPem()).valid).toBe(true);
  });

  it('is deterministic', async () => {
    // Ed25519 has no per-signature randomness, so a repeated signature over
    // the same bytes is identical. No nonce to leak a key through.
    const key = InMemoryKeySource.generate();
    const signer = new Signer(key);
    const a = await signer.sign({ x: 1 });
    const b = await signer.sign({ x: 1 });
    expect(a.signature.value).toBe(b.signature.value);
  });

  it('reports an unusable public key rather than throwing', async () => {
    const signed = await new Signer(InMemoryKeySource.generate()).sign({ x: 1 });
    const result = verifySignature(signed, 'not-a-key');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unusable public key/);
  });

  it('rejects a non-ed25519 key', () => {
    expect(() => InMemoryKeySource.fromPem('k', 'nonsense')).toThrow();
  });

  it('round-trips through PEM', async () => {
    const original = InMemoryKeySource.generate('k1');
    const signed = await new Signer(original).sign({ x: 1 });
    // A second verifier holding only the exported public key.
    expect(verifySignature(signed, original.publicKeyPem()).valid).toBe(true);
  });
});
