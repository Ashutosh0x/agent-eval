import { describe, it, expect, beforeEach } from 'vitest';
import {
  HELD_OUT_SCOPE,
  InMemoryTaskStore,
  SPLITS,
  checkSplitAccess,
  computeTaskSetHash,
  splitDenialAudit,
  type Split,
} from '../../tasks/registry.js';
import type { TenantContext } from '../../store/index.js';

function ctx(scopes: string[], tenantId = 'tenant-a'): TenantContext {
  return { tenantId, actor: 'alice', scopes };
}

describe('held-out access control', () => {
  it('denies a caller who lacks the scope', () => {
    const d = checkSplitAccess(ctx(['runs:write', 'runs:read']), 'HELD_OUT');
    expect(d.outcome).toBe('denied');
    expect(d.status).toBe(403);
    expect(d.requiredScope).toBe(HELD_OUT_SCOPE);
  });

  it('allows a caller who holds it', () => {
    const d = checkSplitAccess(ctx(['runs:write', HELD_OUT_SCOPE]), 'HELD_OUT');
    expect(d.outcome).toBe('allowed');
    expect(d.status).toBe(200);
  });

  it('does not gate TRAIN or DEV', () => {
    for (const split of ['TRAIN', 'DEV'] as Split[]) {
      expect(checkSplitAccess(ctx([]), split).outcome).toBe('allowed');
    }
  });

  it('is not satisfied by a broader scope', () => {
    // The failure mode this guards: "admin implies everything". A
    // contamination control that a general-purpose scope satisfies is not a
    // contamination control.
    for (const scope of ['runs:write', 'admin', '*', 'splits:*', 'splits']) {
      const d = checkSplitAccess(ctx([scope]), 'HELD_OUT');
      expect(`${scope}=>${d.outcome}`).toBe(`${scope}=>denied`);
    }
  });

  it('requires the scope exactly, not as a prefix or substring', () => {
    for (const near of ['splits:held-outX', 'Xsplits:held-out', 'splits:held_out', 'SPLITS:HELD-OUT']) {
      expect(checkSplitAccess(ctx([near]), 'HELD_OUT').outcome).toBe('denied');
    }
  });

  it('has no override path', () => {
    // Every split is either ungated or requires the one scope; there is no
    // third state a caller could argue into.
    for (const split of SPLITS) {
      const without = checkSplitAccess(ctx([]), split);
      const with_ = checkSplitAccess(ctx([HELD_OUT_SCOPE]), split);
      if (split === 'HELD_OUT') {
        expect(without.outcome).toBe('denied');
        expect(with_.outcome).toBe('allowed');
      } else {
        expect(without.outcome).toBe('allowed');
      }
    }
  });

  it('explains why in the refusal, so it is not a mystery 403', () => {
    const d = checkSplitAccess(ctx([]), 'HELD_OUT');
    expect(d.reason).toContain(HELD_OUT_SCOPE);
    expect(d.reason).toMatch(/not overridable/i);
  });
});

describe('the denial audit entry', () => {
  it('names the actor and what was refused', () => {
    const c = ctx(['runs:write']);
    const payload = splitDenialAudit(c, {
      id: 'ts-1',
      version: '1.0.0',
      split: 'HELD_OUT',
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    expect(payload.split).toBe('HELD_OUT');
    expect(payload.heldScopes).toEqual(['runs:write']);
    expect(payload.requiredScope).toBe(HELD_OUT_SCOPE);
  });

  it('discloses no held-out material', () => {
    // An audit entry about a refused held-out access must not itself leak the
    // thing that was withheld.
    const payload = splitDenialAudit(ctx([]), {
      id: 'ts-1',
      version: '1.0.0',
      split: 'HELD_OUT',
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('groundTruth');
  });
});

describe('task set content hashing', () => {
  const base = { id: 'ts-1', version: '1.0.0', split: 'HELD_OUT' as Split, taskIds: ['t1', 't2'] };

  it('is stable for identical input', () => {
    expect(computeTaskSetHash(base)).toBe(computeTaskSetHash({ ...base }));
  });

  it('changes when membership changes', () => {
    expect(computeTaskSetHash({ ...base, taskIds: ['t1', 't2', 't3'] })).not.toBe(
      computeTaskSetHash(base),
    );
  });

  it('changes when membership is reordered', () => {
    // Order is part of the identity: two sets that evaluate the same tasks in
    // a different order are not interchangeable for a reproducibility claim.
    expect(computeTaskSetHash({ ...base, taskIds: ['t2', 't1'] })).not.toBe(
      computeTaskSetHash(base),
    );
  });

  it('changes when the split changes, for the same tasks', () => {
    // The same tasks scored as DEV and as HELD_OUT are not the same measurement.
    expect(computeTaskSetHash({ ...base, split: 'DEV' })).not.toBe(computeTaskSetHash(base));
  });

  it('changes when the version changes', () => {
    expect(computeTaskSetHash({ ...base, version: '1.0.1' })).not.toBe(computeTaskSetHash(base));
  });

  it('cannot be collided by concatenation of ids', () => {
    // Without a length prefix and per-id delimiter, ["ab","c"] and ["a","bc"]
    // would hash identically.
    expect(computeTaskSetHash({ ...base, taskIds: ['ab', 'c'] })).not.toBe(
      computeTaskSetHash({ ...base, taskIds: ['a', 'bc'] }),
    );
  });

  it('is a pinned sha256 string', () => {
    expect(computeTaskSetHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('the task store', () => {
  let store: InMemoryTaskStore;
  const alice = ctx(['runs:write'], 'tenant-a');
  const bob = ctx(['runs:write'], 'tenant-b');

  beforeEach(() => {
    store = new InMemoryTaskStore();
  });

  it('creates a set and pins its hash', async () => {
    const set = await store.createTaskSet(alice, {
      id: 'ts-1',
      name: 'OSWorld',
      version: '1.0.0',
      split: 'HELD_OUT',
    });
    expect(set.contentHash).toMatch(/^sha256:/);
    expect(set.taskIds).toEqual([]);
  });

  it('re-pins the hash when a task is added', async () => {
    const set = await store.createTaskSet(alice, {
      id: 'ts-1',
      name: 'OSWorld',
      version: '1.0.0',
      split: 'DEV',
    });
    await store.createTask(alice, { id: 't1', taskSetId: 'ts-1', prompt: 'do a thing' });
    const after = await store.getTaskSet(alice, 'ts-1');
    // A set must never be readable with a hash describing different contents.
    expect(after?.contentHash).not.toBe(set.contentHash);
    expect(after?.taskIds).toEqual(['t1']);
  });

  it('isolates tenants', async () => {
    await store.createTaskSet(alice, { id: 'ts-1', name: 'x', version: '1', split: 'DEV' });
    expect(await store.getTaskSet(bob, 'ts-1')).toBeNull();
    expect(await store.listTaskSets(bob)).toEqual([]);
  });

  it('refuses a task whose set belongs to another tenant', async () => {
    await store.createTaskSet(alice, { id: 'ts-1', name: 'x', version: '1', split: 'DEV' });
    await expect(
      store.createTask(bob, { id: 't1', taskSetId: 'ts-1', prompt: 'p' }),
    ).rejects.toThrow(/does not exist for this tenant/);
  });

  it('filters sets by split', async () => {
    await store.createTaskSet(alice, { id: 'a', name: 'a', version: '1', split: 'TRAIN' });
    await store.createTaskSet(alice, { id: 'b', name: 'b', version: '1', split: 'HELD_OUT' });
    const heldOut = await store.listTaskSets(alice, 'HELD_OUT');
    expect(heldOut.map((s) => s.id)).toEqual(['b']);
  });

  it('exposes per-task egress allowlists for the policy engine', async () => {
    await store.createTaskSet(alice, { id: 'ts-1', name: 'x', version: '1', split: 'DEV' });
    await store.createTask(alice, {
      id: 't1',
      taskSetId: 'ts-1',
      prompt: 'browse',
      egressAllowlist: ['example.com'],
    });
    const data = await store.egressData(alice);
    expect(data['t1']).toEqual(['example.com']);
  });

  it('gives a task with no allowlist an empty one, not a missing key', async () => {
    // A missing key and an empty list both deny in Rego, but an empty list is
    // an explicit statement rather than an accident.
    await store.createTaskSet(alice, { id: 'ts-1', name: 'x', version: '1', split: 'DEV' });
    await store.createTask(alice, { id: 't1', taskSetId: 'ts-1', prompt: 'offline' });
    expect((await store.egressData(alice))['t1']).toEqual([]);
  });

  it('does not leak another tenant\'s egress data', async () => {
    await store.createTaskSet(alice, { id: 'ts-1', name: 'x', version: '1', split: 'DEV' });
    await store.createTask(alice, {
      id: 't1',
      taskSetId: 'ts-1',
      prompt: 'p',
      egressAllowlist: ['secret.internal'],
    });
    expect(await store.egressData(bob)).toEqual({});
  });

  it('rejects a duplicate set id', async () => {
    await store.createTaskSet(alice, { id: 'ts-1', name: 'x', version: '1', split: 'DEV' });
    await expect(
      store.createTaskSet(alice, { id: 'ts-1', name: 'y', version: '2', split: 'DEV' }),
    ).rejects.toThrow(/already exists/);
  });
});
