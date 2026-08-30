/**
 * Verifying a filtered slice of the log.
 *
 * These exist because of a bug that every earlier test missed by accident.
 * Bundle generation verified a run's entries with `verifyChain`, which
 * requires seq to equal array position — true only for a log read whole from
 * genesis. Every test bundled the first run in a fresh log, so the slice
 * happened to start at seq 0 and the check happened to pass.
 *
 * In any real deployment the second run starts at seq 3 or 300, and bundling
 * it failed with "the log is reordered or has a gap" over a log that was
 * completely intact. The flagship feature worked exactly once per process.
 */

import { describe, expect, it } from 'vitest';
import { AuditLog, verifyChain, verifyEntrySlice } from '../../evidence/audit-log.js';

function logWith(subjects: string[]): AuditLog {
  const log = new AuditLog();
  for (const subject of subjects) {
    for (const action of ['run.started', 'run.claimed', 'run.completed']) {
      log.append({ tenantId: 't', actor: 'a', action, subject, payload: {} });
    }
  }
  return log;
}

describe('a slice is not a chain', () => {
  it('accepts a run that is not the first in the log', () => {
    const log = logWith(['run_A', 'run_B']);
    const slice = log.all().filter((e) => e.subject === 'run_B');

    expect(slice.map((e) => e.seq)).toEqual([3, 4, 5]);
    // The regression, stated directly: this is what used to refuse the bundle.
    expect(verifyChain(slice).valid).toBe(false);
    expect(verifyEntrySlice(slice).valid).toBe(true);
  });

  it('still accepts the first run, which is the case that used to work', () => {
    const log = logWith(['run_A', 'run_B']);
    const slice = log.all().filter((e) => e.subject === 'run_A');
    expect(verifyEntrySlice(slice).valid).toBe(true);
  });

  it('rejects a reordered slice', () => {
    const log = logWith(['run_A']);
    const slice = log.all();
    const shuffled = [slice[2]!, slice[0]!, slice[1]!];
    const result = verifyEntrySlice(shuffled);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/reordered|does not follow/);
  });

  it('rejects a duplicated entry', () => {
    const log = logWith(['run_A']);
    const slice = log.all();
    const result = verifyEntrySlice([slice[0]!, slice[0]!]);
    expect(result.valid).toBe(false);
  });

  it('rejects an entry modified after it was written', () => {
    // Removing contiguity must not have removed tamper detection: each entry
    // still has to hash to what it claims.
    const log = logWith(['run_A']);
    const slice = log.all();
    const tampered = [{ ...slice[1]!, action: 'run.approved' }];
    const result = verifyEntrySlice(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/modified after it was written/);
  });

  it('accepts a slice with gaps, because a gap is the filter', () => {
    const log = logWith(['run_A', 'run_B', 'run_C']);
    const every_other = log.all().filter((e) => e.seq % 2 === 0);
    expect(verifyEntrySlice(every_other).valid).toBe(true);
  });

  it('accepts an empty slice', () => {
    expect(verifyEntrySlice([]).valid).toBe(true);
  });

  it('leaves whole-log verification strict', () => {
    // verifyChain still exists and still demands contiguity: for a complete
    // log, a gap really is evidence that something was removed.
    const log = logWith(['run_A', 'run_B']);
    const all = log.all();
    expect(verifyChain(all).valid).toBe(true);
    expect(verifyChain(all.slice(1)).valid).toBe(false);
  });
});
