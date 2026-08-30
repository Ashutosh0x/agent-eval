import { describe, expect, it } from 'vitest';
import {
  ART_19_MINIMUM_DAYS,
  RetentionError,
  assessAnchor,
  planExpiry,
  resolveRetention,
  type WormAnchor,
} from '../../evidence/retention.js';

const FROM = new Date(Date.UTC(2026, 0, 1));
const DAY = 86_400_000;

describe('resolving overlapping regimes', () => {
  it('applies the Article 19 floor', () => {
    const r = resolveRetention(['eu-ai-act-art-19'], FROM);
    expect(r.retainForDays).toBe(ART_19_MINIMUM_DAYS);
    expect(r.governingRule).toBe('eu-ai-act-art-19');
  });

  it('takes the longest floor when regimes overlap', () => {
    // A hospital under both. Satisfying six months would breach HIPAA.
    const r = resolveRetention(['eu-ai-act-art-19', 'hipaa-164-316'], FROM);
    expect(r.governingRule).toBe('hipaa-164-316');
    expect(r.retainForDays).toBe(2191);
    expect(r.applied).toHaveLength(2);
  });

  it('is order-independent', () => {
    const a = resolveRetention(['hipaa-164-316', 'eu-ai-act-art-19'], FROM);
    const b = resolveRetention(['eu-ai-act-art-19', 'hipaa-164-316'], FROM);
    expect(a.governingRule).toBe(b.governingRule);
  });

  it('records every rule considered, not only the winner', () => {
    // The bundle has to show why this period was chosen.
    const r = resolveRetention(['eu-ai-act-art-19', 'sox-17a-4', 'hipaa-164-316'], FROM);
    expect(r.applied.map((x) => x.id)).toEqual([
      'eu-ai-act-art-19',
      'sox-17a-4',
      'hipaa-164-316',
    ]);
    expect(r.applied.every((x) => x.basis.length > 0)).toBe(true);
  });

  it('refuses an unstated basis', () => {
    expect(() => resolveRetention([], FROM)).toThrow(RetentionError);
  });

  it('names the known rules when given an unknown one', () => {
    expect(() => resolveRetention(['made-up'], FROM)).toThrow(/Known rules/);
  });

  it('computes the retain-until date from the floor', () => {
    const r = resolveRetention(['eu-ai-act-art-19'], FROM);
    expect(r.retainUntil.getTime()).toBe(FROM.getTime() + ART_19_MINIMUM_DAYS * DAY);
  });
});

describe('WORM anchoring', () => {
  const required = resolveRetention(['eu-ai-act-art-19'], FROM);

  const anchor = (over: Partial<WormAnchor> = {}): WormAnchor => ({
    location: 's3://evidence-t1/bundles/b1.json',
    mode: 'compliance',
    retainUntil: new Date(FROM.getTime() + 200 * DAY),
    anchoredAt: FROM,
    ...over,
  });

  it('accepts a compliance-mode lock that outlasts the requirement', () => {
    const a = assessAnchor(anchor(), required);
    expect(a.sufficient).toBe(true);
    expect(a.statement).toMatch(/including by an account administrator/);
  });

  it('will not describe an unanchored bundle as retained', () => {
    const a = assessAnchor(null, required);
    expect(a.sufficient).toBe(false);
    expect(a.statement).toMatch(/recorded but not enforced|not anchored/i);
  });

  it('treats governance mode as a deterrent, not a control', () => {
    // A privileged user can override it, so the guarantee is weaker than it looks.
    const a = assessAnchor(anchor({ mode: 'governance' }), required);
    expect(a.sufficient).toBe(false);
    expect(a.problems.join(' ')).toMatch(/override/);
  });

  it('rejects a lock that expires early', () => {
    const a = assessAnchor(
      anchor({ retainUntil: new Date(FROM.getTime() + 100 * DAY) }),
      required,
    );
    expect(a.sufficient).toBe(false);
    expect(a.problems.join(' ')).toMatch(/83 days before/);
  });

  it('never overstates the guarantee in its wording', () => {
    // The statement goes verbatim into an evidence bundle.
    const weak = assessAnchor(anchor({ mode: 'none' }), required);
    expect(weak.statement).not.toMatch(/satisfying|refused by the storage layer/);
  });
});

describe('expiry planning', () => {
  const now = new Date(Date.UTC(2026, 6, 1));

  it('never deletes inside the retention period', () => {
    const plan = planExpiry(
      [{ bundleId: 'b1', retainUntil: new Date(Date.UTC(2027, 0, 1)) }],
      now,
    );
    expect(plan.retained.map((c) => c.bundleId)).toEqual(['b1']);
    expect(plan.due).toEqual([]);
  });

  it('treats a passed floor as eligible, not due', () => {
    // A floor says "not before". Only a ceiling says "not after" -- conflating
    // them is how a retention job destroys evidence somebody still needed.
    const plan = planExpiry(
      [{ bundleId: 'b1', retainUntil: new Date(Date.UTC(2026, 0, 1)) }],
      now,
    );
    expect(plan.eligible.map((c) => c.bundleId)).toEqual(['b1']);
    expect(plan.due).toEqual([]);
  });

  it('marks deletion due only when a ceiling has passed', () => {
    const plan = planExpiry(
      [
        {
          bundleId: 'b1',
          retainUntil: new Date(Date.UTC(2026, 0, 1)),
          deleteBy: new Date(Date.UTC(2026, 5, 1)),
        },
      ],
      now,
    );
    expect(plan.due.map((c) => c.bundleId)).toEqual(['b1']);
  });

  it('partitions a mixed set without losing anything', () => {
    const candidates = [
      { bundleId: 'retained', retainUntil: new Date(Date.UTC(2027, 0, 1)) },
      { bundleId: 'eligible', retainUntil: new Date(Date.UTC(2026, 0, 1)) },
      {
        bundleId: 'due',
        retainUntil: new Date(Date.UTC(2026, 0, 1)),
        deleteBy: new Date(Date.UTC(2026, 5, 1)),
      },
    ];
    const plan = planExpiry(candidates, now);
    expect(plan.retained.length + plan.eligible.length + plan.due.length).toBe(3);
  });
});
