/**
 * Task registry and split access control.
 *
 * A task set is partitioned into TRAIN, DEV and HELD_OUT. The held-out split is
 * the only one whose numbers mean anything for a capability claim, and it stops
 * meaning anything the moment it leaks into the loop that produced the model.
 *
 * SO THE GATE IS DELIBERATELY BLUNT: scheduling a run against a HELD_OUT split
 * requires the `splits:held-out` scope, and a caller without it gets 403 with an
 * audit entry naming them. There is no override, no "just this once" flag and no
 * inherited permission from a broader scope like `runs:write` — a contamination
 * control with an escape hatch is a contamination control that will be escaped.
 *
 * The refusal is audited rather than merely returned, because the interesting
 * signal is not one 403; it is the same actor generating a hundred of them.
 */

import { createHash } from 'node:crypto';
import type { TenantContext } from '../store/index.js';

export type Split = 'TRAIN' | 'DEV' | 'HELD_OUT';

export const SPLITS: readonly Split[] = ['TRAIN', 'DEV', 'HELD_OUT'] as const;

/** The scope a caller must hold to schedule against HELD_OUT. */
export const HELD_OUT_SCOPE = 'splits:held-out';

/**
 * Map a free-form split label onto the controlled vocabulary.
 *
 * Accepts the spellings clients actually send ("held_out", "held-out",
 * "heldout", any casing) and returns null for anything unrecognized.
 *
 * NULL IS NOT "ALLOWED". A caller must treat an unrecognized split as
 * ungoverned-and-therefore-suspect, not as permission — the one thing this
 * must never do is let `split: "HELD-OUT "` slip past the gate because it
 * failed to match a literal.
 */
export function normalizeSplit(raw: string): Split | null {
  const k = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (k === 'HELD_OUT' || k === 'HELDOUT') return 'HELD_OUT';
  if (k === 'TRAIN' || k === 'TRAINING') return 'TRAIN';
  if (k === 'DEV' || k === 'VALIDATION' || k === 'VAL') return 'DEV';
  return null;
}

export interface TaskRecord {
  id: string;
  tenantId: string;
  taskSetId: string;
  /** What the agent is asked to do. */
  prompt: string;
  /** Environment reference the task runs in. */
  environmentRef?: string;
  /**
   * Ground truth used to score an attempt.
   *
   * Held on the task rather than in the trajectory so a trial can never be
   * scored against an answer it was itself allowed to write.
   */
  groundTruth?: Record<string, unknown>;
  /** Domains this task's agent is permitted to reach, fed to the egress policy. */
  egressAllowlist: string[];
  createdAt: Date;
}

export interface TaskSetRecord {
  id: string;
  tenantId: string;
  name: string;
  version: string;
  split: Split;
  taskIds: string[];
  /**
   * SHA-256 over the set's identity and ordered membership.
   *
   * Pinned into the run manifest so a result can be tied to the exact set of
   * tasks that produced it. A set that gains or loses a task gets a different
   * hash, which is what stops "we ran the same benchmark" from being an
   * unfalsifiable claim.
   */
  contentHash: string;
  createdAt: Date;
}

/**
 * Hash a task set's identity and membership.
 *
 * Task ids are hashed IN ORDER and the count is included, so neither a
 * reordering nor a duplicate can collide with a different set. The version and
 * split are included because the same task ids evaluated as DEV and as HELD_OUT
 * are not the same measurement.
 */
export function computeTaskSetHash(input: {
  id: string;
  version: string;
  split: Split;
  taskIds: readonly string[];
}): string {
  const h = createHash('sha256');
  h.update(`taskset:v1\n`);
  h.update(`${input.id}\n${input.version}\n${input.split}\n`);
  h.update(`count:${input.taskIds.length}\n`);
  for (const id of input.taskIds) h.update(`${id}\n`);
  return `sha256:${h.digest('hex')}`;
}

// ------------------------------------------------------------- the gate

export type SplitAccessOutcome = 'allowed' | 'denied';

export interface SplitAccessDecision {
  outcome: SplitAccessOutcome;
  /** HTTP status a route should return. 200 is "carry on". */
  status: 200 | 403;
  reason: string;
  split: Split;
  requiredScope?: string;
}

/**
 * May this caller schedule a run against this split?
 *
 * Pure and synchronous so it is exhaustively testable, and so the route layer
 * cannot accidentally make it conditional on anything else.
 */
export function checkSplitAccess(ctx: TenantContext, split: Split): SplitAccessDecision {
  if (split !== 'HELD_OUT') {
    return {
      outcome: 'allowed',
      status: 200,
      reason: `The ${split} split is not access-controlled.`,
      split,
    };
  }

  if (ctx.scopes.includes(HELD_OUT_SCOPE)) {
    return {
      outcome: 'allowed',
      status: 200,
      reason: `Caller holds ${HELD_OUT_SCOPE}.`,
      split,
    };
  }

  return {
    outcome: 'denied',
    status: 403,
    reason:
      `Scheduling a run against a HELD_OUT split requires the "${HELD_OUT_SCOPE}" scope. ` +
      'Held-out results are only meaningful while the split stays out of the loop that ' +
      'produced the model, so this is not overridable.',
    split,
    requiredScope: HELD_OUT_SCOPE,
  };
}

/** The audit payload for a refusal. Names the actor; carries no task content. */
export function splitDenialAudit(
  ctx: TenantContext,
  taskSet: Pick<TaskSetRecord, 'id' | 'version' | 'split' | 'contentHash'>,
): Record<string, unknown> {
  return {
    taskSetId: taskSet.id,
    taskSetVersion: taskSet.version,
    split: taskSet.split,
    contentHash: taskSet.contentHash,
    requiredScope: HELD_OUT_SCOPE,
    heldScopes: [...ctx.scopes],
    // Deliberately no prompts or ground truth: an audit entry about a refused
    // held-out access must not itself disclose the held-out material.
  };
}

// ------------------------------------------------------------------ store

export interface CreateTaskInput {
  id: string;
  taskSetId: string;
  prompt: string;
  environmentRef?: string;
  groundTruth?: Record<string, unknown>;
  egressAllowlist?: string[];
}

export interface CreateTaskSetInput {
  id: string;
  name: string;
  version: string;
  split: Split;
  taskIds?: string[];
}

export interface TaskStore {
  createTaskSet(ctx: TenantContext, input: CreateTaskSetInput): Promise<TaskSetRecord>;
  getTaskSet(ctx: TenantContext, id: string): Promise<TaskSetRecord | null>;
  listTaskSets(ctx: TenantContext, split?: Split): Promise<TaskSetRecord[]>;
  createTask(ctx: TenantContext, input: CreateTaskInput): Promise<TaskRecord>;
  getTask(ctx: TenantContext, id: string): Promise<TaskRecord | null>;
  listTasks(ctx: TenantContext, taskSetId: string): Promise<TaskRecord[]>;
  /** The per-task egress allowlist, shaped for the OPA `data` document. */
  egressData(ctx: TenantContext): Promise<Record<string, string[]>>;
}

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

export class InMemoryTaskStore implements TaskStore {
  private taskSets = new Map<string, TaskSetRecord>();
  private tasks = new Map<string, TaskRecord>();

  async createTaskSet(ctx: TenantContext, input: CreateTaskSetInput): Promise<TaskSetRecord> {
    if (this.taskSets.has(input.id)) throw new TaskError(`Task set ${input.id} already exists.`);
    const taskIds = input.taskIds ?? [];
    const record: TaskSetRecord = {
      id: input.id,
      tenantId: ctx.tenantId,
      name: input.name,
      version: input.version,
      split: input.split,
      taskIds,
      contentHash: computeTaskSetHash({
        id: input.id,
        version: input.version,
        split: input.split,
        taskIds,
      }),
      createdAt: new Date(),
    };
    this.taskSets.set(record.id, record);
    return record;
  }

  async getTaskSet(ctx: TenantContext, id: string): Promise<TaskSetRecord | null> {
    const s = this.taskSets.get(id);
    return s && s.tenantId === ctx.tenantId ? s : null;
  }

  async listTaskSets(ctx: TenantContext, split?: Split): Promise<TaskSetRecord[]> {
    return [...this.taskSets.values()]
      .filter((s) => s.tenantId === ctx.tenantId)
      .filter((s) => (split ? s.split === split : true))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async createTask(ctx: TenantContext, input: CreateTaskInput): Promise<TaskRecord> {
    if (this.tasks.has(input.id)) throw new TaskError(`Task ${input.id} already exists.`);
    const set = await this.getTaskSet(ctx, input.taskSetId);
    if (!set) throw new TaskError(`Task set ${input.taskSetId} does not exist for this tenant.`);

    const record: TaskRecord = {
      id: input.id,
      tenantId: ctx.tenantId,
      taskSetId: input.taskSetId,
      prompt: input.prompt,
      egressAllowlist: input.egressAllowlist ?? [],
      createdAt: new Date(),
      ...(input.environmentRef ? { environmentRef: input.environmentRef } : {}),
      ...(input.groundTruth ? { groundTruth: input.groundTruth } : {}),
    };
    this.tasks.set(record.id, record);

    // Membership changed, so the pin must change with it. Recomputing here
    // rather than lazily means a set can never be read with a hash that
    // describes different contents than it currently holds.
    const taskIds = [...set.taskIds, record.id];
    this.taskSets.set(set.id, {
      ...set,
      taskIds,
      contentHash: computeTaskSetHash({
        id: set.id,
        version: set.version,
        split: set.split,
        taskIds,
      }),
    });

    return record;
  }

  async getTask(ctx: TenantContext, id: string): Promise<TaskRecord | null> {
    const t = this.tasks.get(id);
    return t && t.tenantId === ctx.tenantId ? t : null;
  }

  async listTasks(ctx: TenantContext, taskSetId: string): Promise<TaskRecord[]> {
    return [...this.tasks.values()]
      .filter((t) => t.tenantId === ctx.tenantId && t.taskSetId === taskSetId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async egressData(ctx: TenantContext): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of this.tasks.values()) {
      if (t.tenantId !== ctx.tenantId) continue;
      out[t.id] = [...t.egressAllowlist];
    }
    return out;
  }
}
