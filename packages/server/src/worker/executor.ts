/**
 * Execution backends.
 *
 * The honest position first: there is no Firecracker supervisor in this
 * repository, no OpenEnv adapter, and no model client. So there are exactly
 * two backends, and neither pretends to be something it is not.
 *
 * `local-process` runs a real child process, captures its real stdout, exit
 * code and wall-clock duration, and reports those. It is genuine execution
 * with no isolation boundary — the guest kernel, the egress proxy and the
 * credential broker do not exist — so it is named for what it is and is
 * refused unless explicitly enabled.
 *
 * Every other backend is `unavailable`. A run configured for `firecracker`
 * fails with a reason naming the missing component rather than quietly
 * running somewhere else and labelling the result "firecracker". Mislabelling
 * the isolation boundary in an audit-grade product would be the worst
 * available failure: the evidence bundle would attest to a property that was
 * never true.
 */

import { spawn } from 'node:child_process';
import { ProviderError } from '../providers/types.js';
import { providerRegistry, resolveConfig } from '../providers/registry.js';

export type ExecutionBackend =
  | 'local-process'
  | 'firecracker'
  | 'cloud-hypervisor'
  | 'gvisor'
  | 'kata'
  | 'trusted-dev';

/** One thing that actually happened, recorded as it happened. */
export interface ExecutionEvent {
  action: string;
  payload: Record<string, unknown>;
}

export interface ExecutionResult {
  outcome: 'completed' | 'failed';
  /** Required when failed. A failure that cannot say why is not a report. */
  reason?: string;
  events: ExecutionEvent[];
}

export interface Executor {
  readonly backend: ExecutionBackend;
  /** Why this backend cannot run, or null when it can. */
  unavailableReason(): string | null;
  /**
   * `tenantId` is passed because a run may name a stored provider credential,
   * and a credential lookup without its tenant is how one tenant ends up
   * using another's key.
   */
  execute(runId: string, manifest: Record<string, unknown>, run?: RunContext): Promise<ExecutionResult>;
}

export class UnavailableExecutor implements Executor {
  constructor(
    readonly backend: ExecutionBackend,
    private readonly reason: string,
  ) {}

  unavailableReason(): string {
    return this.reason;
  }

  async execute(): Promise<ExecutionResult> {
    return { outcome: 'failed', reason: this.reason, events: [] };
  }
}

export interface LocalProcessOptions {
  /** Must be set deliberately. Unisolated execution is not a default. */
  enabled: boolean;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

/**
 * Runs a real child process and reports what it really did.
 *
 * Nothing here is simulated: the pid, exit code, byte counts and duration all
 * come from the process. The verifier result is the exit code, which is the
 * conventional contract and is the only verification signal available without
 * an adapter.
 */
export class LocalProcessExecutor implements Executor {
  readonly backend = 'local-process' as const;

  constructor(private readonly options: LocalProcessOptions) {}

  unavailableReason(): string | null {
    if (!this.options.enabled) {
      return (
        'Local process execution is disabled. It provides no isolation boundary — ' +
        'no guest kernel, no egress control, no credential brokering — so it must be ' +
        'enabled explicitly with AGENT_EVAL_LOCAL_EXEC=1.'
      );
    }
    return null;
  }

  async execute(runId: string, manifest: Record<string, unknown>): Promise<ExecutionResult> {
    const blocked = this.unavailableReason();
    if (blocked) return { outcome: 'failed', reason: blocked, events: [] };

    const events: ExecutionEvent[] = [];
    const command = this.options.command ?? process.execPath;
    const args = this.options.args ?? [
      '-e',
      // A real, deterministic unit of work whose output is checkable.
      'const c=require("node:crypto");' +
        'const h=c.createHash("sha256").update(process.argv[1]).digest("hex");' +
        'process.stdout.write(JSON.stringify({runId:process.argv[1],digest:h}));',
      runId,
    ];
    const timeoutMs = this.options.timeoutMs ?? 30_000;

    const startedAt = Date.now();
    events.push({
      action: 'execution.started',
      payload: {
        backend: this.backend,
        // Named plainly so nobody reading the log later assumes isolation.
        isolated: false,
        command,
        timeoutMs,
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; pid?: number }>(
      (resolve) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        events.push({
          action: 'process.spawned',
          payload: { pid: child.pid ?? null, command },
        });

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          stderr += err.message;
          resolve({ code: null, signal: null, pid: child.pid });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, pid: child.pid });
        });
      },
    );

    const durationMs = Date.now() - startedAt;

    events.push({
      action: 'process.exited',
      payload: {
        exitCode: result.code,
        signal: result.signal,
        durationMs,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      },
    });

    if (timedOut) {
      const reason = `Execution exceeded the ${timeoutMs}ms timeout and was killed.`;
      events.push({ action: 'execution.failed', payload: { reason } });
      return { outcome: 'failed', reason, events };
    }

    // Exit code is the verification signal. Without an adapter there is no
    // rubric to apply, and inventing a score would be fabricating a result.
    const passed = result.code === 0;
    events.push({
      action: 'verifier.result',
      payload: {
        verifier: 'process-exit-code',
        passed,
        exitCode: result.code,
        // The output is recorded so the claim is checkable, capped so a
        // runaway process cannot fill the audit log.
        output: stdout.slice(0, 2000),
        note: 'No rubric was applied: this run had no verifier adapter configured.',
      },
    });

    if (!passed) {
      const reason =
        `Process exited with code ${result.code}` +
        (stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : '.');
      events.push({ action: 'execution.failed', payload: { reason } });
      return { outcome: 'failed', reason, events };
    }

    events.push({ action: 'execution.completed', payload: { durationMs } });
    return { outcome: 'completed', events };
  }
}

/**
 * Pick an executor for a manifest's declared backend.
 *
 * A manifest asking for a backend this deployment cannot provide gets an
 * `UnavailableExecutor`, which fails the run with a reason naming what is
 * missing. It does not silently substitute a different backend.
 */
/**
 * Resolves a stored provider credential, server-side.
 *
 * The worker is given a function rather than the credential store itself, so
 * the executor cannot list, create or enumerate credentials — only decrypt the
 * single one a run names.
 */
/**
 * What the executor is told about the run beyond its manifest.
 *
 * `tenantId` travels with the credential reference because a credential
 * lookup by id alone is how one tenant ends up spending another's key.
 */
export interface RunContext {
  tenantId: string;
  credentialId?: string;
}

export type CredentialResolver = (
  tenantId: string,
  credentialId: string,
) => Promise<{ apiKey?: string; baseUrl?: string } | null>;

export function selectExecutor(
  requested: string,
  local: LocalProcessOptions,
  modelExecEnabled = false,
  resolveCredential?: CredentialResolver,
): Executor {
  // A run whose backend is `model` calls a provider; the isolation backends
  // are about where code runs, which is a separate axis.
  if (requested === 'model') {
    return new ModelExecutor(modelExecEnabled, resolveCredential);
  }
  if (requested === 'local-process' || requested === 'trusted-dev') {
    return new LocalProcessExecutor(local);
  }
  return new UnavailableExecutor(
    requested as ExecutionBackend,
    `Isolation backend "${requested}" is not available in this deployment. ` +
      'The VMM supervisor, egress proxy and credential broker are designed but not built. ' +
      'Configure a run with isolationBackend "local-process" to execute without isolation, ' +
      'and note that the resulting evidence records an unisolated run.',
  );
}


/**
 * Executes a run by calling the configured model provider.
 *
 * The evaluator never learns which provider it is talking to: it resolves one
 * from the registry by id and works in normalized shapes. Adding a provider
 * therefore changes nothing here.
 *
 * Every recorded value comes from the response — text, token counts, latency,
 * finish reason. Nothing is estimated, and a failure carries the provider's
 * own error category rather than a generic one.
 */
export class ModelExecutor implements Executor {
  readonly backend = 'local-process' as const;

  constructor(
    private readonly enabled: boolean,
    private readonly resolveCredential?: CredentialResolver,
  ) {}

  unavailableReason(): string | null {
    if (!this.enabled) {
      return 'Model execution is disabled. Set AGENT_EVAL_MODEL_EXEC=1 to enable it.';
    }
    return null;
  }

  async execute(
    runId: string,
    manifest: Record<string, unknown>,
    run?: RunContext,
  ): Promise<ExecutionResult> {
    const blocked = this.unavailableReason();
    if (blocked) return { outcome: 'failed', reason: blocked, events: [] };

    const model = (manifest as { model?: { identifier?: string; sampling?: Record<string, unknown> } }).model;
    const identifier = model?.identifier ?? '';

    // "provider/model" is how a run names what to call. Anything else cannot
    // be routed, and guessing a provider would run the wrong thing.
    const slash = identifier.indexOf('/');
    if (slash < 1) {
      const reason =
        `Model identifier "${identifier}" is not routable. ` +
        'Use "<provider>/<model-id>", for example "ollama/some-model".';
      return { outcome: 'failed', reason, events: [{ action: 'execution.failed', payload: { reason } }] };
    }

    const providerId = identifier.slice(0, slash);
    const modelId = identifier.slice(slash + 1);
    const events: ExecutionEvent[] = [];

    let provider;
    try {
      provider = providerRegistry.get(providerId);
    } catch (e) {
      const reason = (e as ProviderError).message;
      events.push({ action: 'execution.failed', payload: { reason, providerId } });
      return { outcome: 'failed', reason, events };
    }

    let config = resolveConfig(providerId);

    // A run may name a stored credential. Without this the encrypted store
    // would exist while every run still read the process environment, which
    // is the kind of gap that looks configured and is not.
    const credentialId = run?.credentialId;
    if (credentialId) {
      if (!this.resolveCredential) {
        const reason =
          `Run names provider credential "${credentialId}", but this worker was started ` +
          'without access to the credential store.';
        events.push({ action: 'execution.failed', payload: { reason, credentialId } });
        return { outcome: 'failed', reason, events };
      }
      let revealed;
      try {
        revealed = await this.resolveCredential(run.tenantId, credentialId);
      } catch (e) {
        const reason = (e as Error).message;
        events.push({ action: 'execution.failed', payload: { reason, credentialId } });
        return { outcome: 'failed', reason, events };
      }
      if (!revealed) {
        const reason = `Provider credential "${credentialId}" was not found for this tenant.`;
        events.push({ action: 'execution.failed', payload: { reason, credentialId } });
        return { outcome: 'failed', reason, events };
      }
      // Merged, never logged. The audit event below records the credential id.
      config = { ...config, ...revealed };
    }

    const sampling = model?.sampling ?? {};

    events.push({
      action: 'model.request',
      payload: {
        provider: providerId,
        model: modelId,
        // Safe configuration only. The credential is never recorded.
        sampling,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        // Which credential was used, never the credential.
        ...(credentialId ? { credentialId } : {}),
      },
    });

    try {
      const response = await provider.generate(
        {
          model: modelId,
          messages: [
            {
              role: 'user',
              content: `Run ${runId}. Reply with a one-sentence acknowledgement.`,
            },
          ],
          ...(typeof sampling.temperature === 'number' ? { temperature: sampling.temperature } : {}),
          ...(typeof sampling.max_tokens === 'number' ? { maxTokens: sampling.max_tokens } : {}),
        },
        config,
      );

      events.push({
        action: 'model.response',
        payload: {
          provider: response.provider,
          model: response.model,
          finishReason: response.finishReason,
          latencyMs: response.latencyMs,
          inputTokens: response.usage.inputTokens ?? null,
          outputTokens: response.usage.outputTokens ?? null,
          totalTokens: response.usage.totalTokens ?? null,
          toolCalls: response.toolCalls.length,
          // Capped so a long generation cannot dominate the audit log.
          text: response.text.slice(0, 2000),
          ...(response.providerRequestId ? { providerRequestId: response.providerRequestId } : {}),
        },
      });

      for (const call of response.toolCalls) {
        events.push({
          action: 'tool.call',
          payload: { toolCallId: call.toolCallId, name: call.name, arguments: call.arguments },
        });
      }

      // Without a rubric adapter there is nothing to score against, so the
      // verifier reports only what it actually checked.
      const passed = response.text.trim().length > 0;
      events.push({
        action: 'verifier.result',
        payload: {
          verifier: 'non-empty-response',
          passed,
          note: 'No rubric was applied: this run had no verifier adapter configured.',
        },
      });

      if (!passed) {
        const reason = 'The model returned an empty response.';
        events.push({ action: 'execution.failed', payload: { reason } });
        return { outcome: 'failed', reason, events };
      }

      events.push({ action: 'execution.completed', payload: { latencyMs: response.latencyMs } });
      return { outcome: 'completed', events };
    } catch (e) {
      const err = e as ProviderError;
      const reason =
        err instanceof ProviderError
          ? `${err.category}: ${err.message}`
          : `Provider call failed: ${(e as Error).message}`;
      events.push({
        action: 'model.error',
        payload: err instanceof ProviderError ? err.toJSON() : { message: (e as Error).message },
      });
      events.push({ action: 'execution.failed', payload: { reason } });
      return { outcome: 'failed', reason, events };
    }
  }
}
