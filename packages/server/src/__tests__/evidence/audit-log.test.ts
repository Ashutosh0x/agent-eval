/**
 * The previous version of this file defined `computeHash` inside itself and
 * tested that function against itself, so it passed with no audit log in the
 * product. These exercise the real one.
 *
 * The cases that matter are the tampering ones. A hash chain that only ever
 * gets tested on well-formed input tells you nothing -- the whole reason to
 * build one is what it does when the data has been changed underneath it.
 */

import { describe, expect, it } from 'vitest';
import { AuditLog, GENESIS_HASH, entryDigest, verifyChain } from '../../evidence/audit-log.js';
import type { AuditEntry } from '../../evidence/audit-log.js';
import { verifyConsistency, verifyInclusion } from '../../evidence/proof-verifier.js';

function log(n: number): AuditLog {
  const l = new AuditLog();
  for (let i = 0; i < n; i++) {
    l.append({
      action: 'run.step',
      actor: 'agent@example.test',
      tenantId: 'tenant-a',
      subject: `run-${i}`,
      payload: { step: i, tokens: i * 100 },
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    });
  }
  return l;
}

/** Deep clone through JSON, as a database round-trip would. */
function clone(entries: readonly AuditEntry[]): AuditEntry[] {
  return JSON.parse(JSON.stringify(entries)) as AuditEntry[];
}

describe('audit log chaining', () => {
  it('starts from the genesis hash', () => {
    const l = new AuditLog();
    const first = l.append({ action: 'run.started', actor: 'u', tenantId: 't' });
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(first.seq).toBe(0);
  });

  it('links each entry to its predecessor', () => {
    const entries = log(10).all();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.previousHash).toBe(entries[i - 1]!.entryHash);
    }
  });

  it('verifies an untouched log', () => {
    const result = log(50).verify();
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(50);
  });

  it('survives a JSON round-trip', () => {
    // The failure this guards: key order changing through storage would break
    // every hash if serialization were not canonical.
    const entries = clone(log(20).all());
    expect(verifyChain(entries).valid).toBe(true);
  });

  it('requires an actor, action and tenant', () => {
    const l = new AuditLog();
    expect(() => l.append({ action: '', actor: 'u', tenantId: 't' })).toThrow(/action/);
    expect(() => l.append({ action: 'a', actor: '', tenantId: 't' })).toThrow(/actor/);
    expect(() => l.append({ action: 'a', actor: 'u', tenantId: '' })).toThrow(/tenantId/);
  });

  it('rejects an unrepresentable payload without recording anything', () => {
    const l = new AuditLog();
    l.append({ action: 'ok', actor: 'u', tenantId: 't' });
    expect(() =>
      l.append({ action: 'bad', actor: 'u', tenantId: 't', payload: { n: Number.NaN } }),
    ).toThrow();
    // The rejected event must not have half-written itself into the chain.
    expect(l.size).toBe(1);
    expect(l.verify().valid).toBe(true);
  });
});

describe('tamper detection', () => {
  it('detects an edited payload', () => {
    const entries = clone(log(10).all());
    entries[4]!.payload = { step: 4, tokens: 0 };
    const result = verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4);
    expect(result.reason).toMatch(/modified/);
  });

  it('detects an edited actor', () => {
    const entries = clone(log(6).all());
    entries[2]!.actor = 'someone-else';
    expect(verifyChain(entries).brokenAt).toBe(2);
  });

  it('detects a deleted entry', () => {
    const entries = clone(log(10).all());
    entries.splice(5, 1);
    const result = verifyChain(entries);
    expect(result.valid).toBe(false);
    // Position 5 now holds the entry that claims seq 6.
    expect(result.reason).toMatch(/reordered|gap/);
  });

  it('detects reordered entries', () => {
    const entries = clone(log(8).all());
    [entries[3], entries[4]] = [entries[4]!, entries[3]!];
    expect(verifyChain(entries).valid).toBe(false);
  });

  it('detects an appended entry that was never chained', () => {
    const entries = clone(log(5).all());
    entries.push({
      seq: 5,
      recordedAt: new Date().toISOString(),
      action: 'injected',
      actor: 'attacker',
      tenantId: 'tenant-a',
      subject: null,
      payload: {},
      previousHash: 'f'.repeat(64),
      entryHash: 'f'.repeat(64),
    });
    const result = verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(5);
  });

  it('catches an entry rehashed to look self-consistent', () => {
    // A tamperer who knows the scheme edits the payload *and* recomputes the
    // hash. The edit still breaks the next entry's previousHash link, which is
    // the property that makes a chain worth having.
    const entries = clone(log(6).all());
    entries[2]!.payload = { step: 2, tokens: 999999 };
    const { entryHash, ...rest } = entries[2]!;
    entries[2]!.entryHash = entryDigest(rest);

    const result = verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/does not follow/);
  });

  it('accepts an empty log', () => {
    expect(verifyChain([]).valid).toBe(true);
  });
});

describe('proofs over the log', () => {
  it('proves inclusion of any entry without revealing the others', () => {
    const l = log(17);
    const root = l.root();
    for (let seq = 0; seq < l.size; seq++) {
      // The verifier gets the entry hash, not the payload.
      const result = verifyInclusion(l.inclusionProof(seq), l.leafFor(seq), root);
      expect(result.valid, `seq ${seq}: ${result.reason ?? ''}`).toBe(true);
    }
  });

  it('proves the log only ever grew', () => {
    const l = log(5);
    const publishedRoot = l.root();
    for (let i = 0; i < 7; i++) {
      l.append({ action: 'run.step', actor: 'a', tenantId: 'tenant-a', payload: { i } });
    }
    const result = verifyConsistency(l.consistencyProof(5), publishedRoot, l.root());
    expect(result.valid, result.reason).toBe(true);
  });

  it('cannot produce a consistency proof against a rewritten prefix', () => {
    // An operator rewrites an old entry, then appends to cover it. The chain
    // catches it; so does the published root from before the rewrite.
    const honest = log(5);
    const publishedRoot = honest.root();

    const rewritten = new AuditLog();
    for (let i = 0; i < 5; i++) {
      rewritten.append({
        action: 'run.step',
        actor: 'agent@example.test',
        tenantId: 'tenant-a',
        subject: `run-${i}`,
        payload: i === 2 ? { step: 2, tokens: 0 } : { step: i, tokens: i * 100 },
        recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
    }
    rewritten.append({ action: 'run.step', actor: 'a', tenantId: 'tenant-a' });

    const result = verifyConsistency(rewritten.consistencyProof(5), publishedRoot, rewritten.root());
    expect(result.valid).toBe(false);
  });

  it('scopes queries by tenant while chaining across all of them', () => {
    const l = new AuditLog();
    l.append({ action: 'a', actor: 'u', tenantId: 'tenant-a' });
    l.append({ action: 'b', actor: 'u', tenantId: 'tenant-b' });
    l.append({ action: 'c', actor: 'u', tenantId: 'tenant-a' });

    expect(l.forTenant('tenant-a')).toHaveLength(2);
    expect(l.forTenant('tenant-b')).toHaveLength(1);
    // One chain covers everything, so a tenant cannot be silently dropped.
    expect(l.verify().valid).toBe(true);
  });
});
