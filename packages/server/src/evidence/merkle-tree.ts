/**
 * RFC 6962 Merkle hash tree.
 *
 * This is the structure that lets an auditor verify two things without being
 * given the whole log:
 *
 *   inclusion    this specific event is in the tree with root R
 *   consistency  the tree with root R2 is an append-only extension of R1,
 *                so nothing already recorded was altered or removed
 *
 * The second one is what makes the log evidence rather than a file. A plain
 * hash chain proves nobody edited history *if you hold the whole chain*; a
 * consistency proof lets a regulator who saw root R1 last quarter check that
 * this quarter's R2 still contains it, in O(log n) hashes.
 *
 * Implemented against RFC 6962 §2.1 exactly, because "Merkle tree" is not one
 * algorithm and the variants are incompatible:
 *
 *   MTH({})       = SHA-256()
 *   MTH({d(0)})   = SHA-256(0x00 || d(0))
 *   MTH(D[n])     = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
 *                   where k is the largest power of two smaller than n
 *
 * Two details are worth stating because they are where compatibility is
 * actually lost, and neither is where you would expect.
 *
 * The split rule is *not* one of them. Pairing leaves left-to-right and
 * promoting the odd one out yields the same root as the power-of-two split for
 * every tree size -- checked exhaustively to n=40. It is the recursion that
 * looks different, not the tree.
 *
 * What does break compatibility:
 *
 *   Bytes, not hex. Child hashes are concatenated as raw 32-byte values. An
 *   implementation that concatenates their hex *strings* computes a different
 *   root at every size above 1 -- again measured, 39 of the first 40 sizes,
 *   n=1 agreeing only because nothing is concatenated. The two look alike, are
 *   each internally consistent, and never interoperate.
 *
 *   Domain separation. The 0x00 / 0x01 prefixes stop an internal node being
 *   presented as a leaf; without them an inclusion proof can be forged for
 *   data that was never logged.
 */

import { createHash } from 'node:crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** MTH({d(0)}) = SHA-256(0x00 || d(0)) */
export function hashLeaf(data: Buffer | string): Buffer {
  return sha256(LEAF_PREFIX, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
}

/** SHA-256(0x01 || left || right) */
export function hashNode(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** The largest power of two strictly smaller than n. Requires n > 1. */
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export interface InclusionProof {
  /** Zero-based index of the leaf this proof is for. */
  leafIndex: number;
  /** Number of leaves in the tree the proof was produced against. */
  treeSize: number;
  /** Sibling hashes, leaf-ward first. */
  path: string[];
}

export interface ConsistencyProof {
  /** Size of the earlier tree. */
  firstSize: number;
  /** Size of the later tree. */
  secondSize: number;
  path: string[];
}

/**
 * An append-only Merkle tree.
 *
 * Leaves are retained so proofs can be produced for any historical entry. For
 * a log that outgrows memory, keep the leaf hashes in the database and rebuild
 * -- the hashes are all that is needed, not the original data.
 */
export class MerkleTree {
  private leaves: Buffer[] = [];

  /** Append a leaf. Returns its index. */
  append(data: Buffer | string): number {
    this.leaves.push(hashLeaf(data));
    return this.leaves.length - 1;
  }

  /** Append an already-hashed leaf, for rebuilding from stored hashes. */
  appendLeafHash(leafHash: Buffer | string): number {
    const buf = Buffer.isBuffer(leafHash) ? leafHash : Buffer.from(leafHash, 'hex');
    if (buf.length !== 32) {
      throw new Error(`leaf hash must be 32 bytes, got ${buf.length}`);
    }
    this.leaves.push(buf);
    return this.leaves.length - 1;
  }

  get size(): number {
    return this.leaves.length;
  }

  leafHashAt(index: number): string {
    const leaf = this.leaves[index];
    if (!leaf) throw new Error(`no leaf at index ${index}`);
    return leaf.toString('hex');
  }

  /** MTH(D[n]) over the whole tree. Empty tree hashes the empty string. */
  root(): string {
    return this.mth(0, this.leaves.length).toString('hex');
  }

  /** MTH over the half-open range [start, end). */
  private mth(start: number, end: number): Buffer {
    const n = end - start;
    if (n === 0) return sha256();
    if (n === 1) return this.leaves[start]!;
    const k = largestPowerOfTwoBelow(n);
    return hashNode(this.mth(start, start + k), this.mth(start + k, end));
  }

  /**
   * PATH(m, D[n]) -- the audit path proving leaf m is in the tree.
   *
   *   m <  k:  PATH(m, D[0:k])     : MTH(D[k:n])
   *   m >= k:  PATH(m - k, D[k:n]) : MTH(D[0:k])
   */
  inclusionProof(leafIndex: number): InclusionProof {
    const n = this.leaves.length;
    if (leafIndex < 0 || leafIndex >= n) {
      throw new Error(`leaf index ${leafIndex} out of range for tree of size ${n}`);
    }
    const path: string[] = [];
    this.buildPath(leafIndex, 0, n, path);
    return { leafIndex, treeSize: n, path };
  }

  private buildPath(m: number, start: number, end: number, out: string[]): void {
    const n = end - start;
    if (n <= 1) return;
    const k = largestPowerOfTwoBelow(n);
    if (m < k) {
      this.buildPath(m, start, start + k, out);
      out.push(this.mth(start + k, end).toString('hex'));
    } else {
      this.buildPath(m - k, start + k, end, out);
      out.push(this.mth(start, start + k).toString('hex'));
    }
  }

  /**
   * PROOF(m, D[n]) -- proof that the tree of size m is a prefix of this tree.
   *
   * This is the append-only guarantee. A verifier holding only the old root
   * can confirm the new tree still contains the old one unchanged.
   */
  consistencyProof(firstSize: number): ConsistencyProof {
    const n = this.leaves.length;
    if (firstSize < 0 || firstSize > n) {
      throw new Error(`first size ${firstSize} out of range for tree of size ${n}`);
    }
    const path: string[] = [];
    if (firstSize > 0 && firstSize < n) {
      this.subproof(firstSize, 0, n, true, path);
    }
    return { firstSize, secondSize: n, path };
  }

  /**
   * SUBPROOF(m, D[n], b).
   *
   * `b` tracks whether the m-sized subtree is still a complete left subtree of
   * the range under consideration. When it is (and m === n), the verifier can
   * derive that node from the old root it already holds, so it is omitted from
   * the proof. Once the recursion descends right, b is false and the node must
   * be sent.
   */
  private subproof(m: number, start: number, end: number, b: boolean, out: string[]): void {
    const n = end - start;
    if (m === n) {
      if (!b) out.push(this.mth(start, end).toString('hex'));
      return;
    }
    const k = largestPowerOfTwoBelow(n);
    if (m <= k) {
      this.subproof(m, start, start + k, b, out);
      out.push(this.mth(start + k, end).toString('hex'));
    } else {
      this.subproof(m - k, start + k, end, false, out);
      out.push(this.mth(start, start + k).toString('hex'));
    }
  }
}
