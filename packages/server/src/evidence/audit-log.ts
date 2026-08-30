/**
 * Hash-chained, append-only audit log with a Merkle tree over it.
 *
 * EU AI Act Article 12 requires high-risk systems to record events
 * automatically over their lifetime; Article 19 requires keeping those records
 * for at least six months. Neither article demands cryptographic integrity --
 * worth being straight about, because the honest pitch is not "the regulation
 * requires this" but "a log an operator can silently edit has little
 * evidentiary weight."
 *
 * Two structures, because they answer different questions:
 *
 *   hash chain    each entry commits to the one before it, so altering entry
 *                 k invalidates every entry after it. Cheap, and detectable
 *                 by anyone holding the full log.
 *   Merkle tree   proves inclusion of one entry, or that this log extends a
 *                 previously published root, in O(log n) -- without handing
 *                 over the log. That is what lets an auditor check a claim
 *                 about one run without reading everyone else's data.
 *
 * What this does not defend against on its own: an attacker who can rewrite
 * the whole log *and* every published root. That is why roots are meant to be
 * anchored somewhere the process cannot reach -- WORM object storage, a
 * timestamp authority, or a counterparty. The chain makes tampering evident;
 * the anchor makes it evident to someone else.
 */

import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';
import { MerkleTree } from './merkle-tree.js';
import type { ConsistencyProof, InclusionProof } from './merkle-tree.js';

/** The hash a chain starts from, so entry 0 is covered like any other. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEventInput {
  /** What happened, e.g. "run.started", "approval.granted", "tool.denied". */
  action: string;
  /** Who or what caused it. A user id, service account, or agent identity. */
  actor: string;
  /** Tenant this belongs to, for row-level isolation. */
  tenantId: string;
  /** The thing acted on, e.g. a run id. */
  subject?: string;
  /** Structured detail. Must be canonicalizable. */
  payload?: Record<string, unknown>;
  /** Overrides the clock. For replaying a recorded history, not for new events. */
  recordedAt?: Date;
}

export interface AuditEntry {
  /** Zero-based position in the log. */
  seq: number;
  recordedAt: string;
  action: string;
  actor: string;
  tenantId: string;
  subject: string | null;
  payload: Record<string, unknown>;
  /** Hash of the entry before this one; GENESIS_HASH for the first. */
  previousHash: string;
  /** SHA-256 over the canonical form of everything above. */
  entryHash: string;
}

export interface ChainVerification {
  valid: boolean;
  /** Entries checked before a failure, or the whole log when valid. */
  checked: number;
  /** Sequence number of the first bad entry. */
  brokenAt?: number;
  reason?: string;
}

/**
 * The bytes an entry hash covers.
 *
 * Exported so a verifier can recompute a hash without this class -- an auditor
 * reimplementing the check should not have to import the implementation being
 * audited.
 */
export function entryDigest(entry: Omit<AuditEntry, 'entryHash'>): string {
  return createHash('sha256').update(canonicalize(entry), 'utf8').digest('hex');
}

/**
 * Verify a chain independently of the log that produced it.
 *
 * Recomputes every hash and checks each entry points at its predecessor, so it
 * catches an edited payload, a reordered entry, and a deletion alike -- a
 * removed entry breaks the `previousHash` link of the one that followed it.
 */
export function verifyChain(entries: readonly AuditEntry[]): ChainVerification {
  let previousHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    if (entry.seq !== i) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry at position ${i} claims seq ${entry.seq}; the log is reordered or has a gap`,
      };
    }
    if (entry.previousHash !== previousHash) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} does not follow entry ${entry.seq - 1}; an entry was removed or replaced`,
      };
    }

    const { entryHash, ...rest } = entry;
    let recomputed: string;
    try {
      recomputed = entryDigest(rest);
    } catch (e) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} cannot be canonicalized: ${(e as Error).message}`,
      };
    }
    if (recomputed !== entryHash) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} was modified after it was written`,
      };
    }

    previousHash = entryHash;
  }

  return { valid: true, checked: entries.length };
}

/**
 * Verify a *filtered* set of entries — one run's entries out of a shared log.
 *
 * `verifyChain` is the wrong tool for this and using it was a real bug: it
 * requires seq to equal position and each entry to name its predecessor's
 * hash, which holds only for a complete log starting at genesis. A bundle
 * contains the entries for one run, so in any deployment that has ever done
 * two things the slice starts at seq 5 or 300 and the check fails on a log
 * that is perfectly intact. In practice the second run was unbundleable.
 *
 * What actually makes a slice trustworthy is two claims, and they are both
 * checked here or alongside:
 *
 *   this entry was not modified   its digest recomputes (checked below)
 *   this entry was in the log     a Merkle inclusion proof against the cited
 *                                 root (checked by verifyBundle, which is
 *                                 exactly what those proofs are for)
 *
 * Contiguity is deliberately not required, because a gap in a filtered view is
 * not evidence of tampering — it is the filter. Ordering still is: entries
 * must ascend, or the slice has been shuffled.
 */
export function verifyEntrySlice(entries: readonly AuditEntry[]): ChainVerification {
  let previousSeq = -1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    if (entry.seq <= previousSeq) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry at position ${i} claims seq ${entry.seq}, which does not follow ${previousSeq}; the slice is reordered or contains a duplicate`,
      };
    }

    const { entryHash, ...rest } = entry;
    let recomputed: string;
    try {
      recomputed = entryDigest(rest);
    } catch (e) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} cannot be canonicalized: ${(e as Error).message}`,
      };
    }
    if (recomputed !== entryHash) {
      return {
        valid: false,
        checked: i,
        brokenAt: entry.seq,
        reason: `entry ${entry.seq} was modified after it was written`,
      };
    }

    previousSeq = entry.seq;
  }

  return { valid: true, checked: entries.length };
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private tree = new MerkleTree();
  private lastHash = GENESIS_HASH;

  /** Append an event. Returns the sealed entry. */
  append(input: AuditEventInput): AuditEntry {
    if (!input.action) throw new Error('an audit event needs an action');
    if (!input.actor) throw new Error('an audit event needs an actor');
    if (!input.tenantId) throw new Error('an audit event needs a tenantId');

    const unsealed: Omit<AuditEntry, 'entryHash'> = {
      seq: this.entries.length,
      recordedAt: (input.recordedAt ?? new Date()).toISOString(),
      action: input.action,
      actor: input.actor,
      tenantId: input.tenantId,
      subject: input.subject ?? null,
      payload: input.payload ?? {},
      previousHash: this.lastHash,
    };

    // Canonicalization can reject the payload. Do it before mutating state so
    // a bad event leaves no partial entry behind.
    const entryHash = entryDigest(unsealed);
    const entry: AuditEntry = { ...unsealed, entryHash };

    this.entries.push(entry);
    this.tree.append(Buffer.from(entryHash, 'hex'));
    this.lastHash = entryHash;
    return entry;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Current Merkle root. This is the value to publish or anchor. */
  root(): string {
    return this.tree.root();
  }

  /** The head of the hash chain. */
  head(): string {
    return this.lastHash;
  }

  all(): readonly AuditEntry[] {
    return this.entries;
  }

  at(seq: number): AuditEntry {
    const entry = this.entries[seq];
    if (!entry) throw new Error(`no audit entry at seq ${seq}`);
    return entry;
  }

  /** Entries for one tenant. The chain still covers the whole log. */
  forTenant(tenantId: string): AuditEntry[] {
    return this.entries.filter((e) => e.tenantId === tenantId);
  }

  /** Proof that entry `seq` is in the tree with the current root. */
  inclusionProof(seq: number): InclusionProof {
    return this.tree.inclusionProof(seq);
  }

  /** Proof that this log extends the one that had `previousSize` entries. */
  consistencyProof(previousSize: number): ConsistencyProof {
    return this.tree.consistencyProof(previousSize);
  }

  /**
   * The leaf bytes for an entry, which a verifier needs alongside the proof.
   * Leaves are the entry hashes, so the verifier never needs the payload to
   * check inclusion -- useful when the payload is confidential.
   */
  leafFor(seq: number): Buffer {
    return Buffer.from(this.at(seq).entryHash, 'hex');
  }

  verify(): ChainVerification {
    return verifyChain(this.entries);
  }
}
