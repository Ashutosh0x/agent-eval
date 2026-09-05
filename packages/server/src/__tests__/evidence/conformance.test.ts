/**
 * The frozen conformance vectors, re-run against the implementation.
 *
 * `conformance/verify.py` proves a second implementation agrees with the
 * vectors. This proves the *first* implementation still does -- which is a
 * different and equally necessary claim, because the vectors are a file and
 * files do not change when code does.
 *
 * A failure here is not a broken test. It means the evidence format changed,
 * and every bundle ever issued now verifies differently. If the change was
 * deliberate the vectors get regenerated and that lands as its own commit,
 * loudly. If it was not, this caught a silent break in the one property the
 * product exists to provide.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { canonicalize } from '../../evidence/canonical.js';
import { MerkleTree, hashLeaf } from '../../evidence/merkle-tree.js';
import { verifyConsistency, verifyInclusion } from '../../evidence/proof-verifier.js';
import { verifyChain } from '../../evidence/audit-log.js';
import { verifySignature } from '../../evidence/signer.js';

const VECTORS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'vectors',
);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(VECTORS, name), 'utf8')) as T;
}

describe('conformance: canonical JSON', () => {
  const data = load<{
    vectors: Array<{ description: string; input: unknown; canonical: string }>;
  }>('canonicalization.json');

  it.each(data.vectors.map((v) => [v.description, v] as const))('%s', (_desc, vector) => {
    expect(canonicalize(vector.input)).toBe(vector.canonical);
  });

  it('still rejects what it promises to reject', () => {
    expect(() => canonicalize({ v: -0 })).toThrow();
    expect(() => canonicalize({ v: NaN })).toThrow();
    expect(() => canonicalize({ v: Infinity })).toThrow();
    expect(() => canonicalize({ v: 1n })).toThrow();
  });
});

describe('conformance: Merkle tree', () => {
  const data = load<{
    emptyRoot: string;
    leafHashes: string[];
    roots: string[];
    inclusion: Array<{ treeSize: number; leafIndex: number; leafHash: string; root: string; path: string[] }>;
    consistency: Array<{ firstSize: number; secondSize: number; firstRoot: string; secondRoot: string; path: string[] }>;
  }>('merkle.json');

  const leafData = (i: number) => `leaf-${i}`;

  it('leaf hashes are unchanged', () => {
    data.leafHashes.forEach((expected, i) => {
      expect(hashLeaf(leafData(i)).toString('hex')).toBe(expected);
    });
  });

  it('every root from n=0 to n=40 is unchanged', () => {
    const tree = new MerkleTree();
    expect(tree.root()).toBe(data.emptyRoot);
    expect(tree.root()).toBe(data.roots[0]);
    for (let n = 1; n < data.roots.length; n++) {
      tree.append(leafData(n - 1));
      expect(tree.root()).toBe(data.roots[n]);
    }
  });

  it('every frozen inclusion proof still verifies', () => {
    for (const c of data.inclusion) {
      const result = verifyInclusion(
        { leafIndex: c.leafIndex, treeSize: c.treeSize, path: c.path },
        leafData(c.leafIndex),
        c.root,
      );
      expect(result.valid, `leaf ${c.leafIndex} of ${c.treeSize}: ${result.reason ?? ''}`).toBe(true);
    }
  });

  it('every frozen consistency proof still verifies', () => {
    for (const c of data.consistency) {
      const result = verifyConsistency(
        { firstSize: c.firstSize, secondSize: c.secondSize, path: c.path },
        c.firstRoot,
        c.secondRoot,
      );
      expect(result.valid, `${c.firstSize}->${c.secondSize}: ${result.reason ?? ''}`).toBe(true);
    }
  });

  it('the prover reproduces the frozen proofs byte for byte', () => {
    // Not just "a valid proof" -- the same one. A prover that emits a
    // different-but-valid path breaks every verifier pinned to these bytes.
    for (const c of data.inclusion) {
      const tree = new MerkleTree();
      for (let i = 0; i < c.treeSize; i++) tree.append(leafData(i));
      expect(tree.inclusionProof(c.leafIndex).path).toEqual(c.path);
    }
    for (const c of data.consistency) {
      const tree = new MerkleTree();
      for (let i = 0; i < c.secondSize; i++) tree.append(leafData(i));
      expect(tree.consistencyProof(c.firstSize).path).toEqual(c.path);
    }
  });
});

describe('conformance: audit chain', () => {
  const data = load<{
    entries: Array<Record<string, unknown>>;
    tamperedEntry: { entry: Record<string, unknown> };
  }>('audit-chain.json');

  it('the frozen chain verifies', () => {
    const result = verifyChain(data.entries as never);
    expect(result.valid, result.reason ?? '').toBe(true);
    expect(result.checked).toBe(data.entries.length);
  });

  it('entry hashes recompute to the frozen values', () => {
    for (const entry of data.entries) {
      const { entryHash, ...rest } = entry;
      const recomputed = createHash('sha256').update(canonicalize(rest), 'utf8').digest('hex');
      expect(recomputed).toBe(entryHash);
    }
  });

  it('the tampered entry is rejected', () => {
    const entries = data.entries.slice(0, 4).concat([data.tamperedEntry.entry]);
    const result = verifyChain(entries as never);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
  });
});

describe('conformance: signature', () => {
  const data = load<{
    publicKeyPem: string;
    signedBytes: string;
    envelope: { payload: Record<string, unknown>; signature: Record<string, unknown> };
    tampered: { envelope: { payload: Record<string, unknown>; signature: Record<string, unknown> } };
  }>('signature.json');

  it('the canonical form of the payload is the frozen signed bytes', () => {
    expect(canonicalize(data.envelope.payload)).toBe(data.signedBytes);
  });

  it('the frozen signature verifies against the frozen key', () => {
    const result = verifySignature(data.envelope as never, data.publicKeyPem);
    expect(result.valid, result.reason ?? '').toBe(true);
  });

  it('the tampered envelope does not', () => {
    const result = verifySignature(data.tampered.envelope as never, data.publicKeyPem);
    expect(result.valid).toBe(false);
  });
});
