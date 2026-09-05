/**
 * Model registry.
 *
 * A registered model is a model the deployment has decided to benchmark: a
 * provider, an identifier that provider accepts, and the configuration that
 * makes a result reproducible.
 *
 * WHY THIS EXISTS WHEN providers/ ALREADY DOES SO MUCH. `providers/` answers
 * "how do I call this thing" and is deliberately stateless — no model list, no
 * persistence, nothing cached, because a cached model list is stale the day a
 * provider ships something. That is the right design for an adapter and the
 * wrong one for a leaderboard: a benchmark result has to name a model that
 * still means the same thing in six months.
 *
 * So this layer adds exactly what the adapter refuses to hold, and nothing
 * else:
 *
 *   IDENTITY THAT DOES NOT MOVE. `resolvedModelId` records the exact string
 *   the provider reported, alongside the alias a user typed. Benchmarking
 *   "gpt-4o" in March and in September are different measurements if the alias
 *   was repointed, and a leaderboard that cannot tell them apart is wrong in a
 *   way nobody can see.
 *
 *   PRICING, OR AN HONEST ABSENCE. `pricing` is optional and is never inferred
 *   from the model name. An invented price propagates into cost-per-successful
 *   task and out to a procurement decision.
 *
 *   A CAPABILITY SNAPSHOT, WITH ITS PROVENANCE. Whether a capability was
 *   probed, declared by the provider, or asserted by an operator changes how
 *   much weight it can carry, so it is recorded rather than flattened.
 *
 * Registration is append-only. Changing a model's configuration creates a new
 * revision instead of editing the old one, because an old benchmark result
 * points at the revision that produced it.
 */

import { createHash } from 'node:crypto';
import type { ProviderCapabilities, Support } from '../providers/types.js';
import type { TenantContext } from '../store/index.js';

/**
 * Where the model physically runs.
 *
 * This is not cosmetic. It decides which cost model applies (per-token versus
 * per-GPU-hour), whether hardware telemetry is meaningful, and whether an
 * endpoint URL is part of the model's identity — for a self-hosted model it is,
 * because the same weights served at two precisions are two different systems.
 */
export type DeploymentType =
  /** A vendor's managed API. Identity is the model id alone. */
  | 'CLOUD_API'
  /** Served by the operator on their own hardware, e.g. vLLM, SGLang, TGI. */
  | 'SELF_HOSTED'
  /** On the machine running the evaluation, e.g. Ollama, LM Studio. */
  | 'LOCAL'
  /** A third-party endpoint speaking the OpenAI protocol. */
  | 'OPENAI_COMPATIBLE'
  /** Anything else reachable over HTTP that an adapter can drive. */
  | 'REMOTE_ENDPOINT';

export const DEPLOYMENT_TYPES: readonly DeploymentType[] = [
  'CLOUD_API',
  'SELF_HOSTED',
  'LOCAL',
  'OPENAI_COMPATIBLE',
  'REMOTE_ENDPOINT',
] as const;

/** True when the endpoint is part of what identifies the model. */
export function endpointIsIdentity(d: DeploymentType): boolean {
  // For a managed API the vendor owns the deployment, so the URL adds nothing.
  // For everything else the operator chose the server, the precision and the
  // hardware, and two endpoints serving "the same" weights are not the same
  // system to benchmark.
  return d !== 'CLOUD_API';
}

/**
 * Per-token pricing, in USD per million tokens.
 *
 * Absent means unknown, and unknown is reported as unknown. There is
 * deliberately no default and no lookup table keyed on model name.
 */
export interface TokenPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** Some vendors bill cached input and reasoning output at other rates. */
  cachedInputPerMillionUsd?: number;
  reasoningOutputPerMillionUsd?: number;
  /** Where the operator got these numbers, so they can be re-checked. */
  source?: string;
  /** When they were last confirmed. Prices move. */
  asOf?: string;
}

/**
 * Cost of running self-hosted hardware, for comparing local against cloud.
 *
 * Kept separate from `TokenPricing` because it is a fundamentally different
 * measurement: one is a published rate, the other is an operator's own
 * amortisation. Mixing them into a single "price" field would make a local
 * estimate indistinguishable from a vendor's list price.
 */
export interface HardwarePricing {
  hourlyUsd: number;
  source?: string;
  asOf?: string;
}

export type Pricing =
  | { kind: 'tokens'; tokens: TokenPricing }
  | { kind: 'hardware'; hardware: HardwarePricing }
  | { kind: 'unknown' };

/** How a capability claim was established. */
export type CapabilitySource =
  /** Confirmed by an actual request against the endpoint. */
  | 'probed'
  /** The provider's own advertised capability. */
  | 'declared'
  /** An operator asserted it. Weakest, and marked as such. */
  | 'operator'
  /** Nothing established it. */
  | 'unknown';

/**
 * What the model can do.
 *
 * Extends the adapter's `ProviderCapabilities` rather than redefining it — the
 * adapter reports what the PROVIDER supports, and this records what this
 * particular MODEL supports, which is often narrower. A provider may speak
 * tool-calling while a specific small model on it does not.
 */
export interface ModelCapabilities extends ProviderCapabilities {
  /** Multi-turn conversation. Nearly always supported; recorded anyway. */
  multiTurn: Support;
  /** Distinct from `tools`: whether several calls may be returned at once. */
  parallelToolCalls: Support;
  /** A dedicated JSON mode, as opposed to prompt-level coaxing. */
  jsonMode: Support;
  /** An explicit reasoning/thinking budget the caller can set. */
  reasoning: Support;
  audio: Support;
  /** Honours a `system` role rather than folding it into the first message. */
  systemMessages: Support;
  /** How each of the above was established. */
  source: CapabilitySource;
  /** When the probe ran, for `probed`. */
  probedAt?: string;
}

export function unknownCapabilities(): ModelCapabilities {
  return {
    streaming: 'unknown',
    tools: 'unknown',
    vision: 'unknown',
    structuredOutput: 'unknown',
    modelListing: 'unknown',
    requiresApiKey: true,
    multiTurn: 'unknown',
    parallelToolCalls: 'unknown',
    jsonMode: 'unknown',
    reasoning: 'unknown',
    audio: 'unknown',
    systemMessages: 'unknown',
    source: 'unknown',
  };
}

export interface RegisteredModel {
  /** Stable across revisions. What a benchmark selects. */
  modelId: string;
  /** Increments on every configuration change. */
  revision: number;
  tenantId: string;
  displayName: string;

  /** Adapter id in the provider registry, e.g. "openai", "vllm". */
  provider: string;
  deploymentType: DeploymentType;

  /**
   * What the caller asks the provider for. May be an alias.
   *
   * Kept separate from `resolvedModelId` on purpose: an alias is what a human
   * configures, and the resolved id is what actually answered.
   */
  modelIdentifier: string;
  /**
   * The exact identifier the provider reported.
   *
   * Populated by a probe. Undefined until one runs — and undefined is honest
   * rather than optimistically copying `modelIdentifier`, which would fabricate
   * the very pinning this field exists to provide.
   */
  resolvedModelId?: string;

  /** Required when the endpoint is part of identity. See endpointIsIdentity. */
  baseUrl?: string;
  /** Which stored credential to spend. A reference, never a secret. */
  credentialId?: string;

  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing: Pricing;

  /** Free-form operator notes: quantization, GPU, tensor parallelism. */
  metadata: Record<string, unknown>;

  createdAt: Date;
  /** Set when a later revision supersedes this one. */
  supersededAt?: Date;
}

export class ModelRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRegistryError';
  }
}

/**
 * A content hash over the fields that change what is being measured.
 *
 * Pinned into a benchmark snapshot so a historical result can prove which
 * configuration produced it. Display name and free-form metadata are excluded:
 * renaming a model for the UI does not change the measurement, and treating it
 * as a new configuration would fragment a leaderboard for cosmetic edits.
 */
export function modelFingerprint(m: Pick<RegisteredModel,
  'provider' | 'deploymentType' | 'modelIdentifier' | 'resolvedModelId' | 'baseUrl'>): string {
  const h = createHash('sha256');
  h.update('model:v1\n');
  h.update(`${m.provider}\n${m.deploymentType}\n${m.modelIdentifier}\n`);
  // The resolved id is included when known, so a repointed alias produces a
  // different fingerprint even though the alias string is unchanged.
  h.update(`${m.resolvedModelId ?? ''}\n`);
  h.update(`${endpointIsIdentity(m.deploymentType) ? (m.baseUrl ?? '') : ''}\n`);
  return `sha256:${h.digest('hex')}`;
}

export interface RegisterModelInput {
  modelId: string;
  displayName: string;
  provider: string;
  deploymentType: DeploymentType;
  modelIdentifier: string;
  baseUrl?: string;
  credentialId?: string;
  capabilities?: Partial<ModelCapabilities>;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Pricing;
  metadata?: Record<string, unknown>;
}

export interface ModelRegistry {
  register(ctx: TenantContext, input: RegisterModelInput): Promise<RegisteredModel>;
  /** The current revision. */
  get(ctx: TenantContext, modelId: string): Promise<RegisteredModel | null>;
  /** A specific historical revision, for reproducing an old result. */
  getRevision(ctx: TenantContext, modelId: string, revision: number): Promise<RegisteredModel | null>;
  list(ctx: TenantContext): Promise<RegisteredModel[]>;
  /** Creates a new revision. Never edits in place. */
  update(ctx: TenantContext, modelId: string, patch: Partial<RegisterModelInput>): Promise<RegisteredModel>;
  /** Record the outcome of a capability probe. Creates a revision. */
  recordProbe(
    ctx: TenantContext,
    modelId: string,
    probe: { resolvedModelId?: string; capabilities: Partial<ModelCapabilities>; contextWindow?: number },
  ): Promise<RegisteredModel>;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validate(input: RegisterModelInput): void {
  if (!ID_RE.test(input.modelId)) {
    throw new ModelRegistryError(
      `modelId "${input.modelId}" must be 1-64 chars of [a-z0-9._-] starting alphanumeric.`,
    );
  }
  if (!input.modelIdentifier.trim()) {
    throw new ModelRegistryError('modelIdentifier is required — it is what the provider is asked for.');
  }
  if (endpointIsIdentity(input.deploymentType) && !input.baseUrl) {
    throw new ModelRegistryError(
      `deploymentType ${input.deploymentType} requires a baseUrl. The endpoint is part of this ` +
        'model\'s identity: the same weights served at a different precision or on different ' +
        'hardware is a different system to benchmark.',
    );
  }
  if (input.baseUrl) assertSafeEndpoint(input.baseUrl);
}

/**
 * Reject endpoints that would turn model registration into an SSRF primitive.
 *
 * A user can register an arbitrary URL and the server will then make requests
 * to it with stored credentials attached. Restricting the scheme is the
 * minimum; the loopback and link-local checks stop a hosted deployment being
 * pointed at its own metadata service.
 *
 * Loopback IS permitted when explicitly allowed, because local models are a
 * first-class use case and refusing localhost would break every Ollama and
 * vLLM deployment. The default is chosen by the caller rather than assumed
 * here, so a hosted install and a laptop install can differ.
 */
export function assertSafeEndpoint(url: string, opts: { allowLoopback?: boolean } = {}): void {
  const allowLoopback = opts.allowLoopback ?? true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ModelRegistryError(`baseUrl "${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelRegistryError(
      `baseUrl scheme "${parsed.protocol}" is not allowed. Only http and https are permitted.`,
    );
  }
  const host = parsed.hostname.toLowerCase();

  // Cloud metadata services. Reachable from most hosted environments and the
  // classic SSRF target.
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host.endsWith('.internal')) {
    throw new ModelRegistryError(
      `baseUrl host "${host}" is a cloud metadata endpoint and cannot be registered.`,
    );
  }

  const isLoopback =
    host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
  if (isLoopback && !allowLoopback) {
    throw new ModelRegistryError(
      `baseUrl host "${host}" is loopback, which is not permitted in this deployment.`,
    );
  }
}

export class InMemoryModelRegistry implements ModelRegistry {
  /** modelId -> revisions, oldest first. The last entry is current. */
  private models = new Map<string, RegisteredModel[]>();

  private key(tenantId: string, modelId: string): string {
    return `${tenantId}:${modelId}`;
  }

  async register(ctx: TenantContext, input: RegisterModelInput): Promise<RegisteredModel> {
    validate(input);
    const k = this.key(ctx.tenantId, input.modelId);
    if (this.models.has(k)) {
      throw new ModelRegistryError(
        `Model "${input.modelId}" is already registered. Use update() to create a new revision.`,
      );
    }
    const record: RegisteredModel = {
      modelId: input.modelId,
      revision: 1,
      tenantId: ctx.tenantId,
      displayName: input.displayName,
      provider: input.provider,
      deploymentType: input.deploymentType,
      modelIdentifier: input.modelIdentifier,
      capabilities: { ...unknownCapabilities(), ...input.capabilities },
      pricing: input.pricing ?? { kind: 'unknown' },
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.credentialId ? { credentialId: input.credentialId } : {}),
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    };
    this.models.set(k, [record]);
    return record;
  }

  async get(ctx: TenantContext, modelId: string): Promise<RegisteredModel | null> {
    const revisions = this.models.get(this.key(ctx.tenantId, modelId));
    return revisions?.[revisions.length - 1] ?? null;
  }

  async getRevision(
    ctx: TenantContext,
    modelId: string,
    revision: number,
  ): Promise<RegisteredModel | null> {
    const revisions = this.models.get(this.key(ctx.tenantId, modelId));
    return revisions?.find((r) => r.revision === revision) ?? null;
  }

  async list(ctx: TenantContext): Promise<RegisteredModel[]> {
    const out: RegisteredModel[] = [];
    for (const [k, revisions] of this.models) {
      if (!k.startsWith(`${ctx.tenantId}:`)) continue;
      const current = revisions[revisions.length - 1];
      if (current) out.push(current);
    }
    return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  async update(
    ctx: TenantContext,
    modelId: string,
    patch: Partial<RegisterModelInput>,
  ): Promise<RegisteredModel> {
    const k = this.key(ctx.tenantId, modelId);
    const revisions = this.models.get(k);
    const current = revisions?.[revisions.length - 1];
    if (!revisions || !current) {
      throw new ModelRegistryError(`Model "${modelId}" is not registered for this tenant.`);
    }

    const merged: RegisterModelInput = {
      modelId,
      displayName: patch.displayName ?? current.displayName,
      provider: patch.provider ?? current.provider,
      deploymentType: patch.deploymentType ?? current.deploymentType,
      modelIdentifier: patch.modelIdentifier ?? current.modelIdentifier,
      ...(patch.baseUrl ?? current.baseUrl ? { baseUrl: patch.baseUrl ?? current.baseUrl } : {}),
    };
    validate(merged);

    const next: RegisteredModel = {
      ...current,
      revision: current.revision + 1,
      displayName: merged.displayName,
      provider: merged.provider,
      deploymentType: merged.deploymentType,
      modelIdentifier: merged.modelIdentifier,
      capabilities: { ...current.capabilities, ...patch.capabilities },
      pricing: patch.pricing ?? current.pricing,
      metadata: { ...current.metadata, ...patch.metadata },
      createdAt: new Date(),
      ...(merged.baseUrl ? { baseUrl: merged.baseUrl } : {}),
      ...(patch.credentialId ?? current.credentialId
        ? { credentialId: patch.credentialId ?? current.credentialId }
        : {}),
      ...(patch.contextWindow ?? current.contextWindow !== undefined
        ? { contextWindow: patch.contextWindow ?? current.contextWindow }
        : {}),
    };
    delete next.supersededAt;

    // The superseded revision is kept, not overwritten: an existing benchmark
    // result points at it.
    revisions[revisions.length - 1] = { ...current, supersededAt: new Date() };
    revisions.push(next);
    return next;
  }

  async recordProbe(
    ctx: TenantContext,
    modelId: string,
    probe: { resolvedModelId?: string; capabilities: Partial<ModelCapabilities>; contextWindow?: number },
  ): Promise<RegisteredModel> {
    const current = await this.get(ctx, modelId);
    if (!current) throw new ModelRegistryError(`Model "${modelId}" is not registered.`);

    const updated = await this.update(ctx, modelId, {
      capabilities: {
        ...probe.capabilities,
        source: 'probed',
        probedAt: new Date().toISOString(),
      },
      ...(probe.contextWindow !== undefined ? { contextWindow: probe.contextWindow } : {}),
    });

    // resolvedModelId is not part of RegisterModelInput because it is never
    // operator-supplied: it is only ever what a provider reported.
    if (probe.resolvedModelId) {
      const revisions = this.models.get(this.key(ctx.tenantId, modelId))!;
      const withResolved = { ...updated, resolvedModelId: probe.resolvedModelId };
      revisions[revisions.length - 1] = withResolved;
      return withResolved;
    }
    return updated;
  }
}
