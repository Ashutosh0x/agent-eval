/**
 * The previous version of this file defined a MerkleTree class inside itself
 * and tested that, so it passed without the product containing any Merkle
 * code at all, and two of its four cases were `expect(true).toBe(true)`.
 *
 * These tests import the real implementation, check it against the formulas in
 * RFC 6962 computed independently here, and verify every proof through
 * proof-verifier.ts -- which does not share tree-walking code with the prover,
 * so agreement between them is evidence rather than tautology.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MerkleTree, hashLeaf, hashNode } from '../../evidence/merkle-tree.js';
import { verifyConsistency, verifyInclusion } from '../../evidence/proof-verifier.js';

/** RFC 6962 MTH, written out longhand as an oracle for the implementation. */
function referenceMTH(data: string[]): string {
  const sha = (...p: Buffer[]) => {
    const h = createHash('sha256');
    for (const x of p) h.update(x);
    return h.digest();
  };
  const leaves = data.map((d) => sha(Buffer.from([0x00]), Buffer.from(d, 'utf8')));
  const mth = (s: number, e: number): Buffer => {
    const n = e - s;
    if (n === 0) return sha();
    if (n === 1) return leaves[s]!;
    let k = 1;
    while (k * 2 < n) k *= 2;
    return sha(Buffer.from([0x01]), mth(s, s + k), mth(s + k, e));
  };
  return mth(0, data.length).toString('hex');
}

function treeOf(n: number): { tree: MerkleTree; data: string[] } {
  const data = Array.from({ length: n }, (_, i) => `event-${i}`);
  const tree = new MerkleTree();
  for (const d of data) tree.append(d);
  return { tree, data };
}

describe('RFC 6962 hashing primitives', () => {
  it('hashes the empty tree to SHA-256 of the empty string', () => {
    expect(new MerkleTree().root()).toBe(createHash('sha256').digest('hex'));
  });

  it('hashes a single leaf as SHA-256(0x00 || d)', () => {
    const tree = new MerkleTree();
    tree.append('single');
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from([0x00]), Buffer.from('single', 'utf8')]))
      .digest('hex');
    expect(tree.root()).toBe(expected);
  });

  it('separates leaf and node domains', () => {
    // Without the 0x00/0x01 prefixes these would collide, which is what lets
    // an internal node be passed off as a leaf.
    const asLeaf = hashLeaf(Buffer.alloc(64));
    const asNode = hashNode(Buffer.alloc(32), Buffer.alloc(32));
    expect(asLeaf.toString('hex')).not.toBe(asNode.toString('hex'));
  });

  it('combines child hashes as bytes, not as hex strings', () => {
    // The failure mode that silently produces an incompatible tree.
    const a = hashLeaf('a');
    const b = hashLeaf('b');
    const asBytes = hashNode(a, b).toString('hex');
    const asHexText = createHash('sha256')
      .update('\x01' + a.toString('hex') + b.toString('hex'))
      .digest('hex');
    expect(asBytes).not.toBe(asHexText);
  });
});

describe('Merkle root', () => {
  it('matches the RFC formula for every size up to 64', () => {
    for (let n = 0; n <= 64; n++) {
      const { tree, data } = treeOf(n);
      expect(tree.root(), `size ${n}`).toBe(referenceMTH(data));
    }
  });

  it('changes when any leaf changes', () => {
    const { tree } = treeOf(16);
    const before = tree.root();
    const tampered = new MerkleTree();
    for (let i = 0; i < 16; i++) tampered.append(i === 7 ? 'tampered' : `event-${i}`);
    expect(tampered.root()).not.toBe(before);
  });

  it('rebuilds identically from stored leaf hashes', () => {
    // The path a server takes when the log outgrows memory.
    const { tree } = treeOf(21);
    const rebuilt = new MerkleTree();
    for (let i = 0; i < tree.size; i++) rebuilt.appendLeafHash(tree.leafHashAt(i));
    expect(rebuilt.root()).toBe(tree.root());
  });
});

describe('inclusion proofs', () => {
  it('verifies every leaf of every tree size up to 33', () => {
    for (let n = 1; n <= 33; n++) {
      const { tree, data } = treeOf(n);
      const root = tree.root();
      for (let m = 0; m < n; m++) {
        const result = verifyInclusion(tree.inclusionProof(m), data[m]!, root);
        expect(result.valid, `n=${n} m=${m}: ${result.reason ?? ''}`).toBe(true);
      }
    }
  });

  it('keeps proofs logarithmic', () => {
    const { tree } = treeOf(1024);
    expect(tree.inclusionProof(500).path.length).toBeLessThanOrEqual(10);
  });

  it('rejects a proof for data that was never logged', () => {
    const { tree } = treeOf(8);
    const result = verifyInclusion(tree.inclusionProof(3), 'never-happened', tree.root());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  it('rejects a proof replayed at the wrong index', () => {
    const { tree, data } = treeOf(8);
    const proof = tree.inclusionProof(3);
    const moved = { ...proof, leafIndex: 4 };
    expect(verifyInclusion(moved, data[3]!, tree.root()).valid).toBe(false);
  });

  it('rejects a truncated proof', () => {
    const { tree, data } = treeOf(8);
    const proof = tree.inclusionProof(3);
    const short = { ...proof, path: proof.path.slice(0, -1) };
    expect(verifyInclusion(short, data[3]!, tree.root()).valid).toBe(false);
  });

  it('rejects a proof with a substituted sibling', () => {
    const { tree, data } = treeOf(8);
    const proof = tree.inclusionProof(3);
    const forged = { ...proof, path: [...proof.path] };
    forged.path[0] = 'f'.repeat(64);
    expect(verifyInclusion(forged, data[3]!, tree.root()).valid).toBe(false);
  });

  it('reports malformed input instead of throwing', () => {
    const { tree, data } = treeOf(4);
    const proof = tree.inclusionProof(1);
    const bad = { ...proof, path: ['not-hex'] };
    const result = verifyInclusion(bad, data[1]!, tree.root());
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});

describe('consistency proofs', () => {
  it('verifies every (m, n) pair up to n=33', () => {
    for (let n = 1; n <= 33; n++) {
      const { tree, data } = treeOf(n);
      const secondRoot = tree.root();
      for (let m = 1; m <= n; m++) {
        const older = new MerkleTree();
        for (let i = 0; i < m; i++) older.append(data[i]!);
        const result = verifyConsistency(tree.consistencyProof(m), older.root(), secondRoot);
        expect(result.valid, `m=${m} n=${n}: ${result.reason ?? ''}`).toBe(true);
      }
    }
  });

  it('detects history rewritten under an append', () => {
    // The attack the whole structure exists to catch: an old entry is edited,
    // then new entries are appended to hide it.
    const { data } = treeOf(8);
    const honest = new MerkleTree();
    for (let i = 0; i < 5; i++) honest.append(data[i]!);
    const oldRoot = honest.root();

    const rewritten = new MerkleTree();
    for (let i = 0; i < 8; i++) rewritten.append(i === 2 ? 'altered-after-the-fact' : data[i]!);

    const result = verifyConsistency(rewritten.consistencyProof(5), oldRoot, rewritten.root());
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/earlier root|altered/);
  });

  it('accepts an unchanged tree only with an empty proof', () => {
    const { tree } = treeOf(6);
    const root = tree.root();
    expect(verifyConsistency({ firstSize: 6, secondSize: 6, path: [] }, root, root).valid).toBe(true);
    expect(
      verifyConsistency({ firstSize: 6, secondSize: 6, path: ['0'.repeat(64)] }, root, root).valid,
    ).toBe(false);
  });

  it('treats every tree as an extension of the empty tree', () => {
    const { tree } = treeOf(4);
    const empty = new MerkleTree().root();
    expect(verifyConsistency(tree.consistencyProof(0), empty, tree.root()).valid).toBe(true);
  });

  it('rejects a proof against the wrong earlier root', () => {
    const { tree } = treeOf(8);
    const wrong = new MerkleTree();
    wrong.append('different-history');
    expect(verifyConsistency(tree.consistencyProof(5), wrong.root(), tree.root()).valid).toBe(false);
  });

  it('refuses a shrinking tree', () => {
    const result = verifyConsistency(
      { firstSize: 9, secondSize: 4, path: [] },
      '0'.repeat(64),
      '1'.repeat(64),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });
});
