/**
 * In-process Rego policy evaluation.
 *
 * The policies under `policies/` are compiled to WebAssembly by
 * `scripts/build-policy-bundle.sh` and evaluated here, in the same process as
 * the thing being gated.
 *
 * WHY NOT AN OPA SIDECAR. A gate that crosses a network boundary fails open the
 * moment the sidecar is unreachable — unless every call site remembers to treat
 * a connection error as a deny, which is exactly the discipline that erodes.
 * In-process, "the engine is down" and "the policy said no" cannot be confused,
 * because there is no transport in between to fail.
 *
 * FAIL CLOSED, ALWAYS. If the bundle is missing, malformed, or an evaluation
 * throws, every decision is a deny with the reason attached. A policy engine
 * that cannot answer must not be interpretable as permission — and because the
 * failure is recorded on the decision rather than thrown away, an operator can
 * see the difference between "policy denied this" and "policy could not run".
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The decisions this build knows how to ask for. */
export type PolicyEntrypoint =
  | 'agenteval/approval/require_approval'
  | 'agenteval/egress/allow_egress'
  | 'agenteval/budget/deny_budget'
  | 'agenteval/authz/allow';

/**
 * The result of one evaluation.
 *
 * `evaluated` is the field that matters for correctness. A caller must be able
 * to distinguish a policy that returned false from an engine that never ran,
 * and both produce a restrictive outcome — so without this flag they would be
 * indistinguishable in the audit record.
 */
export interface PolicyDecision {
  /** The raw value the entrypoint returned. `undefined` when it did not run. */
  readonly value: unknown;
  /** True only when the WASM module actually produced this value. */
  readonly evaluated: boolean;
  /** Why the engine could not answer. Set only when `evaluated` is false. */
  readonly unavailableReason?: string;
  /** SHA-256 of the bundle that produced it — pins the decision to a policy version. */
  readonly bundleDigest: string;
  readonly entrypoint: PolicyEntrypoint;
  readonly durationMs: number;
}

/**
 * The subset of `@open-policy-agent/opa-wasm` this module uses.
 *
 * Declared structurally rather than imported as a type so the package stays a
 * runtime-only dependency: the server must still typecheck in an environment
 * where it has not been installed, and the engine's fail-closed path is what
 * covers its absence at runtime.
 */
interface LoadedPolicy {
  setData(data: unknown): void;
  evaluate(input: unknown, entrypoint?: string): Array<{ result: unknown }>;
}

type PolicyLoader = (wasm: Buffer) => Promise<LoadedPolicy>;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default location of the committed bundle, relative to the built output. */
export const DEFAULT_BUNDLE_PATH = resolve(HERE, '../../policy-bundle/policy.wasm');

export interface PolicyEngineOptions {
  /** Path to policy.wasm. Defaults to the bundle committed with the server. */
  bundlePath?: string;
  /**
   * External data the policies read via `data.*`.
   *
   * `budget.threshold` and `task_allowlist` live here. Supplied by the caller
   * rather than baked into the bundle so a deployment can change a threshold
   * without recompiling Rego.
   */
  data?: Record<string, unknown>;
  /** Injected in tests. Production resolves the real opa-wasm loader. */
  loader?: PolicyLoader;
}

/** Resolve the real loader lazily, so an uninstalled package fails closed. */
const defaultLoader: PolicyLoader = async (wasm) => {
  const mod = (await import('@open-policy-agent/opa-wasm')) as unknown as {
    loadPolicy: (w: Buffer) => Promise<LoadedPolicy>;
  };
  return mod.loadPolicy(wasm);
};

export class PolicyEngine {
  private policy: LoadedPolicy | null = null;
  private loadFailure: string | null = null;
  private digest = 'unloaded';
  private readonly bundlePath: string;
  private readonly data: Record<string, unknown>;
  private readonly loader: PolicyLoader;
  private loading: Promise<void> | null = null;

  constructor(options: PolicyEngineOptions = {}) {
    this.bundlePath = options.bundlePath ?? DEFAULT_BUNDLE_PATH;
    this.data = options.data ?? {};
    this.loader = options.loader ?? defaultLoader;
  }

  /**
   * Load and instantiate the bundle.
   *
   * Idempotent and safe to call concurrently: the in-flight promise is shared,
   * so N simultaneous first requests instantiate one module rather than N.
   */
  async load(): Promise<void> {
    if (this.policy || this.loadFailure) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        const wasm = await readFile(this.bundlePath);
        // The digest goes onto every decision, which is what lets an auditor
        // prove which policy version produced a historical allow or deny.
        this.digest = `sha256:${createHash('sha256').update(wasm).digest('hex')}`;
        const policy = await this.loader(wasm);
        policy.setData(this.data);
        this.policy = policy;
      } catch (e) {
        this.loadFailure =
          `Policy bundle could not be loaded from ${this.bundlePath}: ` +
          `${(e as Error).message}. Run scripts/build-policy-bundle.sh. ` +
          'Every decision will fail closed until it is available.';
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  /** True when the engine can actually answer. */
  get ready(): boolean {
    return this.policy !== null;
  }

  get bundleDigest(): string {
    return this.digest;
  }

  get unavailableReason(): string | null {
    return this.loadFailure;
  }

  /**
   * Evaluate one entrypoint.
   *
   * Never throws. An engine that throws on the tool-call path would have to be
   * wrapped in a try/catch at every call site, and the first site that forgot
   * would fail open.
   */
  async evaluate(entrypoint: PolicyEntrypoint, input: unknown): Promise<PolicyDecision> {
    const started = Date.now();
    await this.load();

    if (!this.policy) {
      return {
        value: undefined,
        evaluated: false,
        unavailableReason: this.loadFailure ?? 'Policy engine is not loaded.',
        bundleDigest: this.digest,
        entrypoint,
        durationMs: Date.now() - started,
      };
    }

    try {
      const results = this.policy.evaluate(input, entrypoint);
      // opa-wasm returns [] when the entrypoint produced no document — an
      // undefined decision, not a false one. Treated as "did not evaluate" so
      // it fails closed rather than reading as a permissive default.
      if (!Array.isArray(results) || results.length === 0) {
        return {
          value: undefined,
          evaluated: false,
          unavailableReason: `Entrypoint "${entrypoint}" returned no result.`,
          bundleDigest: this.digest,
          entrypoint,
          durationMs: Date.now() - started,
        };
      }
      return {
        value: results[0]?.result,
        evaluated: true,
        bundleDigest: this.digest,
        entrypoint,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      return {
        value: undefined,
        evaluated: false,
        unavailableReason: `Policy evaluation threw: ${(e as Error).message}`,
        bundleDigest: this.digest,
        entrypoint,
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * Read a decision as a boolean, choosing the safe answer when unavailable.
   *
   * `safeDefault` is required, not defaulted: whether "unavailable" means true
   * or false depends on the polarity of the rule. `require_approval` fails
   * closed at TRUE (demand a human), `allow_egress` fails closed at FALSE
   * (refuse the connection). A single default would be wrong for one of them.
   */
  async decideBoolean(
    entrypoint: PolicyEntrypoint,
    input: unknown,
    safeDefault: boolean,
  ): Promise<{ result: boolean; decision: PolicyDecision }> {
    const decision = await this.evaluate(entrypoint, input);
    if (!decision.evaluated) return { result: safeDefault, decision };
    if (typeof decision.value !== 'boolean') {
      // A non-boolean from a boolean rule is a policy bug; take the safe side.
      return {
        result: safeDefault,
        decision: {
          ...decision,
          evaluated: false,
          unavailableReason: `Expected boolean from "${entrypoint}", got ${typeof decision.value}.`,
        },
      };
    }
    return { result: decision.value, decision };
  }
}
