/**
 * Independent verification of RFC 6962 inclusion and consistency proofs.
 *
 * This file deliberately shares no tree-walking code with merkle-tree.ts. A
 * verifier built by calling back into the prover proves only that the prover
 * is self-consistent -- it would happily confirm a wrong-but-consistent tree.
 * These functions reconstruct the root from the proof alone, using the
 * iterative algorithm from RFC 6962 2.1.1 / 2.1.2, and compare.
 *
 * That independence is the point of the whole evidence layer: a regulator
 * should be able to reimplement this from the RFC and get the same answer
 * without running our code at all.
 *
 * Everything here is pure. No I/O, no clock, no config -- a proof either
 * verifies or it does not, and that fact does not depend on the machine.
 */

import { hashLeaf, hashNode } from './merkle-tree.js';
import type { ConsistencyProof, InclusionProof } from './merkle-tree.js';

function hexToBuf(hex: string): Buffer {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`expected a 32-byte hex hash, got ${buf.length} bytes`);
  }
  return buf;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export interface VerificationResult {
  valid: boolean;
  /** Why it failed, for an audit report. Absent when valid. */
  reason?: string;
  /** The root the proof actually reconstructs to, when one could be computed. */
  computedRoot?: string;
}

/**
 * Verify that `leafData` sits at `leafIndex` of the tree whose root is
 * `expectedRoot`.
 *
 * Walks up from the leaf, choosing at each level whether the sibling is on the
 * left or the right. `fn` is the index within the current level and `sn` the
 * last index at that level; a node is a right child when `fn` is odd, and the
 * `fn === sn` case handles the ragged right edge of a non-power-of-two tree.
 */
export function verifyInclusion(
  proof: InclusionProof,
  leafData: Buffer | string,
  expectedRoot: string,
): VerificationResult {
  const { leafIndex, treeSize, path } = proof;

  if (treeSize <= 0) return { valid: false, reason: 'tree size must be positive' };
  if (leafIndex < 0 || leafIndex >= treeSize) {
    return { valid: false, reason: `leaf index ${leafIndex} outside tree of size ${treeSize}` };
  }

  let fn = leafIndex;
  let sn = treeSize - 1;
  let hash: Buffer;
  try {
    hash = hashLeaf(leafData);
  } catch (e) {
    return { valid: false, reason: `could not hash leaf: ${(e as Error).message}` };
  }

  for (const sibling of path) {
    if (sn === 0) {
      return { valid: false, reason: 'proof is longer than the tree is deep' };
    }
    let node: Buffer;
    try {
      node = hexToBuf(sibling);
    } catch (e) {
      return { valid: false, reason: `malformed proof node: ${(e as Error).message}` };
    }

    if (fn % 2 === 1 || fn === sn) {
      hash = hashNode(node, hash);
      while (fn !== 0 && fn % 2 === 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      hash = hashNode(hash, node);
    }
    fn >>= 1;
    sn >>= 1;
  }

  if (sn !== 0) {
    return { valid: false, reason: 'proof is shorter than the tree is deep' };
  }

  const computedRoot = hash.toString('hex');
  if (computedRoot !== expectedRoot) {
    return { valid: false, reason: 'reconstructed root does not match', computedRoot };
  }
  return { valid: true, computedRoot };
}

/**
 * Verify that the tree with root `secondRoot` is an append-only extension of
 * the tree with root `firstRoot`.
 *
 * This is the check that catches a rewritten history: an entry altered or
 * removed after the fact changes the old subtree, and no consistency proof
 * exists between the two roots.
 *
 * Two roots are reconstructed in step: `fr` toward the old root and `sr`
 * toward the new one. When the old tree is a perfect subtree (size a power of
 * two) its root is not carried in the proof, because the verifier already
 * holds it.
 */
export function verifyConsistency(
  proof: ConsistencyProof,
  firstRoot: string,
  secondRoot: string,
): VerificationResult {
  const { firstSize, secondSize, path } = proof;

  if (firstSize > secondSize) {
    return { valid: false, reason: `first size ${firstSize} exceeds second ${secondSize}` };
  }
  if (firstSize === secondSize) {
    if (path.length > 0) {
      return { valid: false, reason: 'equal sizes require an empty proof' };
    }
    return firstRoot === secondRoot
      ? { valid: true, computedRoot: secondRoot }
      : { valid: false, reason: 'equal sizes but roots differ' };
  }
  // Every tree extends the empty tree, and there is nothing to prove.
  if (firstSize === 0) {
    return path.length === 0
      ? { valid: true }
      : { valid: false, reason: 'extension of the empty tree requires an empty proof' };
  }

  let fn = firstSize - 1;
  let sn = secondSize - 1;
  while (fn % 2 === 1) {
    fn >>= 1;
    sn >>= 1;
  }

  let index = 0;
  let fr: Buffer;
  let sr: Buffer;
  try {
    if (isPowerOfTwo(firstSize)) {
      // The old root is a complete subtree; the verifier supplies it.
      fr = hexToBuf(firstRoot);
      sr = fr;
    } else {
      if (path.length === 0) return { valid: false, reason: 'proof is empty' };
      fr = hexToBuf(path[0]!);
      sr = fr;
      index = 1;
    }
  } catch (e) {
    return { valid: false, reason: `malformed proof node: ${(e as Error).message}` };
  }

  for (; index < path.length; index++) {
    if (sn === 0) {
      return { valid: false, reason: 'proof is longer than the tree is deep' };
    }
    let node: Buffer;
    try {
      node = hexToBuf(path[index]!);
    } catch (e) {
      return { valid: false, reason: `malformed proof node: ${(e as Error).message}` };
    }

    if (fn % 2 === 1 || fn === sn) {
      fr = hashNode(node, fr);
      sr = hashNode(node, sr);
      while (fn !== 0 && fn % 2 === 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      sr = hashNode(sr, node);
    }
    fn >>= 1;
    sn >>= 1;
  }

  if (sn !== 0) {
    return { valid: false, reason: 'proof is shorter than the tree is deep' };
  }

  const computedFirst = fr.toString('hex');
  const computedSecond = sr.toString('hex');

  if (computedFirst !== firstRoot) {
    return {
      valid: false,
      reason: 'proof does not reconstruct the earlier root -- history was altered',
      computedRoot: computedFirst,
    };
  }
  if (computedSecond !== secondRoot) {
    return {
      valid: false,
      reason: 'proof does not reconstruct the later root',
      computedRoot: computedSecond,
    };
  }
  return { valid: true, computedRoot: computedSecond };
}
