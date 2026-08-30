/**
 * Retention policy and WORM anchoring.
 *
 * EU AI Act Art. 19: providers "shall keep the logs ... for a period
 * appropriate to the intended purpose of the high-risk AI system, of at least
 * six months, unless provided otherwise in the applicable Union or national
 * law."
 *
 * Two things in that sentence are routinely misread.
 *
 * Six months is a *floor*, not a period. Sectoral law regularly requires
 * longer -- HIPAA §164.316(b)(2)(i) is six years for documentation, and
 * Annex IV technical documentation is ten. Where regimes overlap the longest
 * applicable period governs, so this module resolves a policy set rather than
 * applying a single number.
 *
 * And "keep" is not "store". A retention date the application can move is a
 * preference. What makes it a control is object-lock in compliance mode, where
 * the storage layer refuses deletion until the date passes -- including by the
 * account root. This module records whether that actually happened, and
 * refuses to describe an unanchored bundle as retained.
 *
 * Deletion is the other half. Storing evidence beyond its retention period is
 * not a safe default: GDPR storage limitation runs the other way, and holding
 * agent trajectories containing personal data forever creates the liability
 * the buyer was trying to avoid. So a policy has both a floor and a ceiling,
 * and expiry is a scheduled action rather than an omission.
 */

/** EU AI Act Art. 19 minimum, in days. Six months, taken as 183. */
export const ART_19_MINIMUM_DAYS = 183;

const DAY_MS = 86_400_000;

export interface RetentionRule {
  /** Short identifier, e.g. "eu-ai-act-art-19". */
  id: string;
  /** The provision this comes from, for the evidence bundle. */
  basis: string;
  minimumDays: number;
  /**
   * Latest permissible retention. Null means no upper bound in this regime.
   * A ceiling below another rule's floor is a genuine conflict, surfaced
   * rather than silently resolved.
   */
  maximumDays?: number | null;
}

/**
 * Rules shipped by default.
 *
 * Deliberately not exhaustive, and deliberately not presented as legal
 * advice -- an operator adds the regimes that apply to them.
 */
export const STANDARD_RULES: Readonly<Record<string, RetentionRule>> = {
  'eu-ai-act-art-19': {
    id: 'eu-ai-act-art-19',
    basis: 'EU AI Act Art. 19 — automatically generated logs, at least six months',
    minimumDays: ART_19_MINIMUM_DAYS,
    maximumDays: null,
  },
  'eu-ai-act-annex-iv': {
    id: 'eu-ai-act-annex-iv',
    basis: 'EU AI Act Art. 11 + Annex IV — technical documentation, ten years',
    minimumDays: 3653,
    maximumDays: null,
  },
  'hipaa-164-316': {
    id: 'hipaa-164-316',
    basis: 'HIPAA §164.316(b)(2)(i) — documentation retained six years',
    minimumDays: 2191,
    maximumDays: null,
  },
  'sox-17a-4': {
    id: 'sox-17a-4',
    basis: 'SEC 17a-4 — records preserved, commonly six years',
    minimumDays: 2191,
    maximumDays: null,
  },
  'gdpr-storage-limitation': {
    id: 'gdpr-storage-limitation',
    basis: 'GDPR Art. 5(1)(e) — kept no longer than necessary',
    minimumDays: 0,
    // A tenant sets this to its own documented limit; there is no universal
    // number, and inventing one would be worse than requiring a decision.
    maximumDays: null,
  },
};

export class RetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionError';
  }
}

export interface ResolvedRetention {
  /** Days the evidence must be kept, the maximum of every applicable floor. */
  retainForDays: number;
  retainUntil: Date;
  /** Which rule set the floor. */
  governingRule: string;
  /** Every rule considered, for the bundle's audit trail. */
  applied: RetentionRule[];
  /** Ceiling, when any regime imposes one. */
  deleteByDays?: number;
  deleteBy?: Date;
}

/**
 * Resolve overlapping regimes into one period.
 *
 * The longest floor wins, because satisfying the shortest would breach the
 * others. A ceiling below the winning floor is irreconcilable and throws --
 * that is a real conflict for a lawyer, not something to paper over by
 * picking one.
 */
export function resolveRetention(
  ruleIds: readonly string[],
  from: Date = new Date(),
): ResolvedRetention {
  if (ruleIds.length === 0) {
    throw new RetentionError(
      'at least one retention rule is required; evidence with no stated basis ' +
        'for its retention period cannot be defended',
    );
  }

  const applied: RetentionRule[] = [];
  for (const id of ruleIds) {
    const rule = STANDARD_RULES[id];
    if (!rule) {
      throw new RetentionError(
        `unknown retention rule "${id}". Known rules: ${Object.keys(STANDARD_RULES).join(', ')}`,
      );
    }
    applied.push(rule);
  }

  let governing = applied[0]!;
  for (const rule of applied) {
    if (rule.minimumDays > governing.minimumDays) governing = rule;
  }
  const retainForDays = governing.minimumDays;

  const ceilings = applied
    .map((r) => r.maximumDays)
    .filter((d): d is number => typeof d === 'number');
  const deleteByDays = ceilings.length > 0 ? Math.min(...ceilings) : undefined;

  if (deleteByDays !== undefined && deleteByDays < retainForDays) {
    throw new RetentionError(
      `retention rules conflict: ${governing.id} requires ${retainForDays} days, ` +
        `but a ceiling of ${deleteByDays} days also applies. This needs a legal ` +
        'decision, not a default.',
    );
  }

  return {
    retainForDays,
    retainUntil: new Date(from.getTime() + retainForDays * DAY_MS),
    governingRule: governing.id,
    applied,
    ...(deleteByDays !== undefined
      ? { deleteByDays, deleteBy: new Date(from.getTime() + deleteByDays * DAY_MS) }
      : {}),
  };
}

export type LockMode = 'compliance' | 'governance' | 'none';

export interface WormAnchor {
  /** Where the object landed, e.g. an s3:// URI. */
  location: string;
  /**
   * Compliance mode blocks deletion by everyone including the account root.
   * Governance mode allows a privileged override, which means it is a
   * deterrent rather than a control.
   */
  mode: LockMode;
  retainUntil: Date;
  anchoredAt: Date;
}

export interface AnchorAssessment {
  /** Whether this satisfies the resolved retention period. */
  sufficient: boolean;
  /** Wording for the evidence bundle. Never overstates the guarantee. */
  statement: string;
  problems: string[];
}

/**
 * Assess whether an anchor actually delivers the retention it claims.
 *
 * Called before a bundle asserts anything about retention, so the bundle
 * cannot say "retained under Art. 19" about an object nobody locked.
 */
export function assessAnchor(
  anchor: WormAnchor | null,
  required: ResolvedRetention,
): AnchorAssessment {
  const problems: string[] = [];

  if (!anchor) {
    return {
      sufficient: false,
      statement:
        'Not anchored to write-once storage. The retention period is recorded but ' +
        'not enforced, so this evidence can be deleted by anyone with write access.',
      problems: ['no anchor'],
    };
  }

  if (anchor.mode === 'none') {
    problems.push('object lock is not enabled');
  }
  if (anchor.mode === 'governance') {
    problems.push(
      'object lock is in governance mode, which a privileged user can override',
    );
  }
  if (anchor.retainUntil.getTime() < required.retainUntil.getTime()) {
    const shortBy = Math.ceil(
      (required.retainUntil.getTime() - anchor.retainUntil.getTime()) / DAY_MS,
    );
    problems.push(`lock expires ${shortBy} days before the required period ends`);
  }

  if (problems.length === 0) {
    return {
      sufficient: true,
      statement:
        `Anchored to write-once storage in compliance mode until ` +
        `${anchor.retainUntil.toISOString().slice(0, 10)}, satisfying ` +
        `${required.governingRule} (${required.retainForDays} days). Deletion is ` +
        'refused by the storage layer until that date, including by an account administrator.',
      problems,
    };
  }

  return {
    sufficient: false,
    statement:
      'Retention is recorded but not fully enforced: ' + problems.join('; ') + '.',
    problems,
  };
}

export interface ExpiryCandidate {
  bundleId: string;
  retainUntil: Date;
  deleteBy?: Date;
}

export interface ExpiryPlan {
  /** Past its ceiling and due for deletion. */
  due: ExpiryCandidate[];
  /** Past its floor but with no ceiling; deletion is a decision, not automatic. */
  eligible: ExpiryCandidate[];
  /** Still inside its retention period. Deleting these would breach it. */
  retained: ExpiryCandidate[];
}

/**
 * Partition stored evidence by what may be deleted.
 *
 * Nothing is deleted automatically merely because its floor passed. A floor
 * says "not before"; only a ceiling says "not after". Conflating the two is
 * how a retention job destroys evidence somebody still needed.
 */
export function planExpiry(
  candidates: readonly ExpiryCandidate[],
  now: Date = new Date(),
): ExpiryPlan {
  const plan: ExpiryPlan = { due: [], eligible: [], retained: [] };
  for (const c of candidates) {
    if (c.retainUntil.getTime() > now.getTime()) {
      plan.retained.push(c);
    } else if (c.deleteBy && c.deleteBy.getTime() <= now.getTime()) {
      plan.due.push(c);
    } else {
      plan.eligible.push(c);
    }
  }
  return plan;
}
