/**
 * Storage seam.
 *
 * The API depends on this interface, not on Prisma. Two reasons that matter
 * beyond the usual testability argument:
 *
 * The audit log is append-only by construction here -- there is no update or
 * delete on `AuditStore`, so no route can be written that mutates history even
 * by accident. Enforcing that in the type system is worth more than enforcing
 * it in a code review.
 *
 * And every method takes a tenant. In the Postgres implementation the tenant
 * also goes onto the session so Row-Level Security enforces isolation in the
 * database; a query that forgets its tenant then returns nothing rather than
 * returning someone else's data. The in-memory implementation mirrors the
 * filtering so tests catch a missing tenant the same way production would.
 */

import type { AuditEntry, ConsistencyProof, InclusionProof } from '../evidence/index.js';
import { AuditLog } from '../evidence/index.js';

export interface TenantContext {
  tenantId: string;
  actor: string;
  scopes: readonly string[];
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  subject?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Append-only by type. Note the absence of update and delete: retention is
 * enforced by object lock, and an endpoint that could remove an entry would
 * make the log something other than an audit log.
 */
export interface AuditStore {
  append(ctx: TenantContext, event: Omit<Parameters<AuditLog['append']>[0], 'tenantId' | 'actor'>): Promise<AuditEntry>;
  query(ctx: TenantContext, q: AuditQuery): Promise<Page<AuditEntry>>;
  at(ctx: TenantContext, seq: number): Promise<AuditEntry | null>;
  root(): Promise<{ root: string; size: number }>;
  inclusionProof(seq: number): Promise<InclusionProof>;
  consistencyProof(fromSize: number): Promise<ConsistencyProof>;
  entriesForSubject(ctx: TenantContext, subject: string): Promise<AuditEntry[]>;
  verify(): Promise<{ valid: boolean; brokenAt?: number; reason?: string }>;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
  id: string;
  tenantId: string;
  status: RunStatus;
  manifest: Record<string, unknown>;
  retentionRules: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  /** Which worker holds this run. Set by claim, cleared on terminal status. */
  claimedBy?: string;
  claimedAt?: Date;
  /** Populated on failure. A run that failed must be able to say why. */
  failureReason?: string;
  /**
   * Which stored provider credential this run should spend, if any.
   *
   * Deliberately outside the manifest: the manifest is the reproducibility
   * record and is hashed into evidence, and which credential paid for a call
   * is an operational fact rather than part of what was run. A reference only
   * — the secret is decrypted at execution time and never stored here.
   */
  credentialId?: string;
}

export interface RunStore {
  create(ctx: TenantContext, run: Omit<RunRecord, 'tenantId'>): Promise<RunRecord>;
  get(ctx: TenantContext, id: string): Promise<RunRecord | null>;
  list(ctx: TenantContext, q: { cursor?: string; limit: number }): Promise<Page<RunRecord>>;
  setStatus(ctx: TenantContext, id: string, status: RunStatus): Promise<RunRecord | null>;
  /**
   * Atomically move one queued run to running and stamp the claimant.
   *
   * Cross-tenant by design: a worker serves the whole deployment, not one
   * tenant. The atomicity is what stops two workers executing the same run --
   * in Postgres this becomes
   *
   *   UPDATE runs SET status='running', claimed_by=$1
   *   WHERE id = (SELECT id FROM runs WHERE status='queued'
   *               ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
   *   RETURNING *
   *
   * Single-statement, so the race cannot be lost between read and write.
   */
  claimNext(workerId: string): Promise<RunRecord | null>;
  /** Record a terminal outcome. `reason` is required for a failure. */
  finish(id: string, status: 'completed' | 'failed', reason?: string): Promise<RunRecord | null>;
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  runId: string;
  action: string;
  status: 'pending' | 'approved' | 'rejected' | 'escalated' | 'timed-out';
  deadline: Date;
  /** What happens if nobody acts. Required, so somebody decided it. */
  onTimeout: 'deny' | 'allow';
  trajectoryContext: { trialId: string; throughStep: number };
  decidedBy?: string;
  decidedAt?: Date;
  rationale?: string;
  createdAt: Date;
}

export interface ApprovalStore {
  create(ctx: TenantContext, a: Omit<ApprovalRecord, 'tenantId'>): Promise<ApprovalRecord>;
  get(ctx: TenantContext, id: string): Promise<ApprovalRecord | null>;
  list(ctx: TenantContext, status?: ApprovalRecord['status']): Promise<ApprovalRecord[]>;
  decide(
    ctx: TenantContext,
    id: string,
    decision: { status: ApprovalRecord['status']; rationale: string; decidedBy: string },
  ): Promise<ApprovalRecord | null>;
}

export interface BundleRecord {
  id: string;
  tenantId: string;
  runId: string;
  bundle: unknown;
  retainUntil: Date;
  deleteBy?: Date;
  createdAt: Date;
}

export interface BundleStore {
  create(ctx: TenantContext, b: Omit<BundleRecord, 'tenantId'>): Promise<BundleRecord>;
  get(ctx: TenantContext, id: string): Promise<BundleRecord | null>;
  list(ctx: TenantContext): Promise<BundleRecord[]>;
}

export interface Stores {
  audit: AuditStore;
  runs: RunStore;
  approvals: ApprovalStore;
  bundles: BundleStore;
}

// ------------------------------------------------------------ in-memory impl

function paginate<T>(items: T[], cursor: string | undefined, limit: number): Page<T> {
  const start = cursor ? Number.parseInt(cursor, 10) : 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return { items: slice, ...(next < items.length ? { nextCursor: String(next) } : {}) };
}

export class InMemoryAuditStore implements AuditStore {
  private log = new AuditLog();

  async append(
    ctx: TenantContext,
    event: { action: string; subject?: string; payload?: Record<string, unknown>; recordedAt?: Date },
  ): Promise<AuditEntry> {
    return this.log.append({ ...event, tenantId: ctx.tenantId, actor: ctx.actor });
  }

  async query(ctx: TenantContext, q: AuditQuery): Promise<Page<AuditEntry>> {
    let items = this.log.forTenant(ctx.tenantId);
    if (q.actor) items = items.filter((e) => e.actor === q.actor);
    if (q.action) items = items.filter((e) => e.action === q.action);
    if (q.subject) items = items.filter((e) => e.subject === q.subject);
    if (q.from) items = items.filter((e) => Date.parse(e.recordedAt) >= q.from!.getTime());
    if (q.to) items = items.filter((e) => Date.parse(e.recordedAt) <= q.to!.getTime());
    return paginate(items, q.cursor, q.limit);
  }

  async at(ctx: TenantContext, seq: number): Promise<AuditEntry | null> {
    if (seq < 0 || seq >= this.log.size) return null;
    const entry = this.log.at(seq);
    // Cross-tenant reads return null, matching what RLS would do.
    return entry.tenantId === ctx.tenantId ? entry : null;
  }

  async root() {
    return { root: this.log.root(), size: this.log.size };
  }

  async inclusionProof(seq: number) {
    return this.log.inclusionProof(seq);
  }

  async consistencyProof(fromSize: number) {
    return this.log.consistencyProof(fromSize);
  }

  async entriesForSubject(ctx: TenantContext, subject: string): Promise<AuditEntry[]> {
    return this.log.forTenant(ctx.tenantId).filter((e) => e.subject === subject);
  }

  async verify() {
    const r = this.log.verify();
    return {
      valid: r.valid,
      ...(r.brokenAt !== undefined ? { brokenAt: r.brokenAt } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    };
  }

  /** The leaf bytes for a sequence number, for proof verification. */
  leafFor(seq: number): Buffer {
    return Buffer.from(this.log.at(seq).entryHash, 'hex');
  }
}

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, RunRecord>();

  async create(ctx: TenantContext, run: Omit<RunRecord, 'tenantId'>): Promise<RunRecord> {
    const record: RunRecord = { ...run, tenantId: ctx.tenantId };
    this.runs.set(record.id, record);
    return record;
  }

  async get(ctx: TenantContext, id: string): Promise<RunRecord | null> {
    const r = this.runs.get(id);
    return r && r.tenantId === ctx.tenantId ? r : null;
  }

  async list(ctx: TenantContext, q: { cursor?: string; limit: number }): Promise<Page<RunRecord>> {
    const items = [...this.runs.values()]
      .filter((r) => r.tenantId === ctx.tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return paginate(items, q.cursor, q.limit);
  }

  async setStatus(ctx: TenantContext, id: string, status: RunStatus) {
    const r = await this.get(ctx, id);
    if (!r) return null;
    const updated = { ...r, status, ...(status === 'completed' ? { completedAt: new Date() } : {}) };
    this.runs.set(id, updated);
    return updated;
  }

  async claimNext(workerId: string): Promise<RunRecord | null> {
    // Node runs this to completion without interleaving, which gives the same
    // guarantee the SQL above does: no two callers can observe the same
    // queued run before one of them has written 'running'.
    const queued = [...this.runs.values()]
      .filter((r) => r.status === 'queued')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const next = queued[0];
    if (!next) return null;

    const claimed: RunRecord = {
      ...next,
      status: 'running',
      claimedBy: workerId,
      claimedAt: new Date(),
      startedAt: new Date(),
    };
    this.runs.set(claimed.id, claimed);
    return claimed;
  }

  async finish(
    id: string,
    status: 'completed' | 'failed',
    reason?: string,
  ): Promise<RunRecord | null> {
    const r = this.runs.get(id);
    if (!r) return null;
    const updated: RunRecord = {
      ...r,
      status,
      completedAt: new Date(),
      ...(reason ? { failureReason: reason } : {}),
    };
    this.runs.set(id, updated);
    return updated;
  }

  /** For the worker, which has no tenant context of its own. */
  async getById(id: string): Promise<RunRecord | null> {
    return this.runs.get(id) ?? null;
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private approvals = new Map<string, ApprovalRecord>();

  async create(ctx: TenantContext, a: Omit<ApprovalRecord, 'tenantId'>): Promise<ApprovalRecord> {
    const record: ApprovalRecord = { ...a, tenantId: ctx.tenantId };
    this.approvals.set(record.id, record);
    return record;
  }

  async get(ctx: TenantContext, id: string): Promise<ApprovalRecord | null> {
    const a = this.approvals.get(id);
    return a && a.tenantId === ctx.tenantId ? a : null;
  }

  async list(ctx: TenantContext, status?: ApprovalRecord['status']): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()]
      .filter((a) => a.tenantId === ctx.tenantId)
      .filter((a) => (status ? a.status === status : true))
      .sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
  }

  async decide(
    ctx: TenantContext,
    id: string,
    decision: { status: ApprovalRecord['status']; rationale: string; decidedBy: string },
  ): Promise<ApprovalRecord | null> {
    const a = await this.get(ctx, id);
    if (!a) return null;
    const updated: ApprovalRecord = {
      ...a,
      status: decision.status,
      rationale: decision.rationale,
      decidedBy: decision.decidedBy,
      decidedAt: new Date(),
    };
    this.approvals.set(id, updated);
    return updated;
  }
}

export class InMemoryBundleStore implements BundleStore {
  private bundles = new Map<string, BundleRecord>();

  async create(ctx: TenantContext, b: Omit<BundleRecord, 'tenantId'>): Promise<BundleRecord> {
    const record: BundleRecord = { ...b, tenantId: ctx.tenantId };
    this.bundles.set(record.id, record);
    return record;
  }

  async get(ctx: TenantContext, id: string): Promise<BundleRecord | null> {
    const b = this.bundles.get(id);
    return b && b.tenantId === ctx.tenantId ? b : null;
  }

  async list(ctx: TenantContext): Promise<BundleRecord[]> {
    return [...this.bundles.values()]
      .filter((b) => b.tenantId === ctx.tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

export function createInMemoryStores(): Stores & { audit: InMemoryAuditStore } {
  return {
    audit: new InMemoryAuditStore(),
    runs: new InMemoryRunStore(),
    approvals: new InMemoryApprovalStore(),
    bundles: new InMemoryBundleStore(),
  };
}
