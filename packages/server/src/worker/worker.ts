/**
 * The run worker.
 *
 * This is what was missing: nothing in the control plane ever moved a run out
 * of `queued`, so every run sat there forever and the UI truthfully reported a
 * state that would never change.
 *
 * The loop is deliberately dull. Claim one run atomically, execute it, append
 * every event the executor reported to the audit log, then record a terminal
 * status. No step invents anything: the events come from the process, the
 * hashes come from the audit service, and a failure carries the reason the
 * executor gave.
 *
 * Audit entries are written by the worker through the same `AuditStore` the
 * API uses, so the hash chain covers execution and API activity in one
 * sequence. That matters: a log where execution and administration are chained
 * separately cannot prove their ordering relative to each other.
 */

import type { AuditStore, RunStore, TenantContext } from '../store/index.js';
import type { Executor } from './executor.js';

export interface WorkerOptions {
  runs: RunStore;
  audit: AuditStore;
  /** Chooses an executor for a run's declared backend. */
  selectExecutor: (backend: string) => Executor;
  /** Identifies the claimant in the audit trail. */
  workerId?: string;
  /** How long to wait when the queue is empty. */
  pollIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface WorkerStatus {
  running: boolean;
  workerId: string;
  claimed: number;
  completed: number;
  failed: number;
  lastActivityAt?: Date;
}

export class RunWorker {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private stats = { claimed: 0, completed: 0, failed: 0 };
  private lastActivityAt?: Date;

  constructor(private readonly options: WorkerOptions) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  status(): WorkerStatus {
    return {
      running: !this.stopped,
      workerId: this.workerId,
      ...this.stats,
      ...(this.lastActivityAt ? { lastActivityAt: this.lastActivityAt } : {}),
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.log('info', 'worker started', { workerId: this.workerId });
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    fields: Record<string, unknown> = {},
  ) {
    this.options.log?.(level, message, { workerId: this.workerId, ...fields });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (e) {
        // A worker that dies on one bad run stops the whole queue.
        this.log('error', 'worker tick failed', { error: (e as Error).message });
      }
      if (this.stopped) break;
      if (!didWork) {
        await new Promise((r) => {
          this.timer = setTimeout(r, this.pollIntervalMs);
        });
      }
    }
  }

  /** Claim and execute at most one run. Returns whether anything was claimed. */
  async tick(): Promise<boolean> {
    const run = await this.options.runs.claimNext(this.workerId);
    if (!run) return false;

    this.stats.claimed++;
    this.lastActivityAt = new Date();

    // The worker acts on behalf of the run's tenant so entries land in the
    // right isolation scope, but under its own actor identity — attributing
    // machine execution to the human who queued it would misstate the record.
    const ctx: TenantContext = {
      tenantId: run.tenantId,
      actor: this.workerId,
      scopes: [],
    };

    const backend = String(
      (run.manifest as { isolationBackend?: unknown }).isolationBackend ?? 'unknown',
    );

    this.log('info', 'run claimed', { runId: run.id, backend });
    await this.options.audit.append(ctx, {
      action: 'run.claimed',
      subject: run.id,
      payload: { worker: this.workerId, backend },
    });

    const executor = this.options.selectExecutor(backend);
    const blocked = executor.unavailableReason();

    if (blocked) {
      // Refuse rather than substitute. A run configured for an isolation
      // boundary this deployment lacks must not quietly run somewhere else.
      this.log('warn', 'execution unavailable', { runId: run.id, backend, reason: blocked });
      await this.options.audit.append(ctx, {
        action: 'execution.unavailable',
        subject: run.id,
        payload: { backend, reason: blocked },
      });
      await this.options.audit.append(ctx, {
        action: 'run.failed',
        subject: run.id,
        payload: { reason: blocked },
      });
      await this.options.runs.finish(run.id, 'failed', blocked);
      this.stats.failed++;
      return true;
    }

    let result;
    try {
      result = await executor.execute(run.id, run.manifest);
    } catch (e) {
      const reason = `Executor threw: ${(e as Error).message}`;
      await this.options.audit.append(ctx, {
        action: 'run.failed',
        subject: run.id,
        payload: { reason },
      });
      await this.options.runs.finish(run.id, 'failed', reason);
      this.stats.failed++;
      this.log('error', 'execution threw', { runId: run.id, error: (e as Error).message });
      return true;
    }

    // Every event the executor reported, in order, into the chained log.
    for (const event of result.events) {
      await this.options.audit.append(ctx, {
        action: event.action,
        subject: run.id,
        payload: event.payload,
      });
    }

    await this.options.audit.append(ctx, {
      action: result.outcome === 'completed' ? 'run.completed' : 'run.failed',
      subject: run.id,
      payload: result.reason ? { reason: result.reason } : {},
    });

    await this.options.runs.finish(run.id, result.outcome, result.reason);

    if (result.outcome === 'completed') this.stats.completed++;
    else this.stats.failed++;

    this.log(result.outcome === 'completed' ? 'info' : 'warn', `run ${result.outcome}`, {
      runId: run.id,
      events: result.events.length,
      ...(result.reason ? { reason: result.reason } : {}),
    });

    return true;
  }
}
