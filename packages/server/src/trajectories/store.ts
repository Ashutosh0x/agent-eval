/**
 * Trial and trajectory storage.
 *
 * A trial is one attempt at one task within a run. It owns an ATIF document
 * that grows by append as the agent acts.
 *
 * THE APPEND IS THE WHOLE POINT. `appendStep` refuses an out-of-sequence write
 * rather than reordering, so a client that has lost steps finds out instead of
 * producing a plausible-looking trajectory with a hole in it. That check lives
 * in atif.ts and is reused here rather than re-implemented, so there is exactly
 * one definition of what a valid sequence is.
 *
 * Like the other stores in this codebase every method takes a tenant, and a
 * cross-tenant read returns null rather than throwing — matching what Postgres
 * RLS does, so a missing tenant fails the same way in tests and in production.
 */

import {
  ATIF_VERSION,
  AtifError,
  appendStep,
  nextStepId,
  totals,
  type AgentDescriptor,
  type Trajectory,
  type TrajectoryStep,
  type TrajectoryTotals,
} from './atif.js';
import type { TenantContext } from '../store/index.js';

export type TrialStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'pending_approval'
  | 'terminated_by_policy'
  | 'cancelled';

export interface TrialRecord {
  id: string;
  tenantId: string;
  runId: string;
  taskId: string;
  status: TrialStatus;
  agent: AgentDescriptor;
  steps: TrajectoryStep[];
  startedAt: Date;
  endedAt?: Date;
  outcome?: Trajectory['outcome'];
  score?: number;
  isolationBackend?: string;
  /** Set while suspended, so a resumed trial knows which decision it waits on. */
  pendingApprovalId?: string;
}

export interface CreateTrialInput {
  id: string;
  runId: string;
  taskId: string;
  agent: AgentDescriptor;
  isolationBackend?: string;
}

export interface TrialStore {
  createTrial(ctx: TenantContext, input: CreateTrialInput): Promise<TrialRecord>;
  getTrial(ctx: TenantContext, trialId: string): Promise<TrialRecord | null>;
  listTrialsForRun(ctx: TenantContext, runId: string): Promise<TrialRecord[]>;
  appendStep(ctx: TenantContext, trialId: string, step: TrajectoryStep): Promise<TrialRecord>;
  finishTrial(
    ctx: TenantContext,
    trialId: string,
    outcome: NonNullable<Trajectory['outcome']>,
    score?: number,
  ): Promise<TrialRecord | null>;
  setTrialStatus(
    ctx: TenantContext,
    trialId: string,
    status: TrialStatus,
    approvalId?: string,
  ): Promise<TrialRecord | null>;
  /** The full ATIF document for a run: one trajectory per trial. */
  trajectoriesForRun(ctx: TenantContext, runId: string): Promise<Trajectory[]>;
}

export class TrialNotFoundError extends Error {
  constructor(trialId: string) {
    super(`Trial ${trialId} does not exist, or belongs to another tenant.`);
    this.name = 'TrialNotFoundError';
  }
}

/** Build the ATIF document for a trial. */
export function toTrajectory(trial: TrialRecord): Trajectory {
  return {
    atif_version: ATIF_VERSION,
    trial_id: trial.id,
    run_id: trial.runId,
    task_id: trial.taskId,
    agent: trial.agent,
    started_at: trial.startedAt.toISOString(),
    ...(trial.endedAt ? { ended_at: trial.endedAt.toISOString() } : {}),
    steps: trial.steps,
    ...(trial.outcome ? { outcome: trial.outcome } : {}),
    ...(trial.score !== undefined ? { score: trial.score } : {}),
    ...(trial.isolationBackend ? { isolation_backend: trial.isolationBackend } : {}),
  };
}

export function trialTotals(trial: TrialRecord): TrajectoryTotals {
  return totals({ steps: trial.steps });
}

export class InMemoryTrialStore implements TrialStore {
  private trials = new Map<string, TrialRecord>();

  async createTrial(ctx: TenantContext, input: CreateTrialInput): Promise<TrialRecord> {
    if (this.trials.has(input.id)) {
      throw new AtifError(`Trial ${input.id} already exists.`);
    }
    const record: TrialRecord = {
      id: input.id,
      tenantId: ctx.tenantId,
      runId: input.runId,
      taskId: input.taskId,
      status: 'running',
      agent: input.agent,
      steps: [],
      startedAt: new Date(),
      ...(input.isolationBackend ? { isolationBackend: input.isolationBackend } : {}),
    };
    this.trials.set(record.id, record);
    return record;
  }

  async getTrial(ctx: TenantContext, trialId: string): Promise<TrialRecord | null> {
    const t = this.trials.get(trialId);
    return t && t.tenantId === ctx.tenantId ? t : null;
  }

  async listTrialsForRun(ctx: TenantContext, runId: string): Promise<TrialRecord[]> {
    return [...this.trials.values()]
      .filter((t) => t.tenantId === ctx.tenantId && t.runId === runId)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  async appendStep(
    ctx: TenantContext,
    trialId: string,
    step: TrajectoryStep,
  ): Promise<TrialRecord> {
    const trial = await this.getTrial(ctx, trialId);
    if (!trial) throw new TrialNotFoundError(trialId);

    // A finished trial is a closed record. Appending to one would change what
    // the evidence says happened after it was concluded.
    if (trial.status !== 'running' && trial.status !== 'pending_approval') {
      throw new AtifError(
        `Trial ${trialId} is ${trial.status} and accepts no further steps. ` +
          'A concluded trajectory is a closed record.',
      );
    }

    // Throws on a sequence mismatch; see the note at the top of the file.
    const steps = appendStep(trial.steps, step);
    const updated: TrialRecord = { ...trial, steps };
    this.trials.set(trialId, updated);
    return updated;
  }

  async finishTrial(
    ctx: TenantContext,
    trialId: string,
    outcome: NonNullable<Trajectory['outcome']>,
    score?: number,
  ): Promise<TrialRecord | null> {
    const trial = await this.getTrial(ctx, trialId);
    if (!trial) return null;
    const status: TrialStatus =
      outcome === 'success' ? 'completed' : outcome === 'blocked_by_policy' ? 'terminated_by_policy' : 'failed';
    const updated: TrialRecord = {
      ...trial,
      status,
      outcome,
      endedAt: new Date(),
      ...(score !== undefined ? { score } : {}),
    };
    // A concluded trial is no longer waiting on anyone.
    delete updated.pendingApprovalId;
    this.trials.set(trialId, updated);
    return updated;
  }

  async setTrialStatus(
    ctx: TenantContext,
    trialId: string,
    status: TrialStatus,
    approvalId?: string,
  ): Promise<TrialRecord | null> {
    const trial = await this.getTrial(ctx, trialId);
    if (!trial) return null;
    const updated: TrialRecord = { ...trial, status };
    if (status === 'pending_approval' && approvalId) {
      updated.pendingApprovalId = approvalId;
    } else {
      delete updated.pendingApprovalId;
    }
    this.trials.set(trialId, updated);
    return updated;
  }

  async trajectoriesForRun(ctx: TenantContext, runId: string): Promise<Trajectory[]> {
    const trials = await this.listTrialsForRun(ctx, runId);
    return trials.map(toTrajectory);
  }

  /** The id an append to this trial must use. Exposed for the API's 409 body. */
  async expectedNextStep(ctx: TenantContext, trialId: string): Promise<number | null> {
    const trial = await this.getTrial(ctx, trialId);
    return trial ? nextStepId(trial.steps) : null;
  }
}
