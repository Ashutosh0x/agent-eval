/**
 * Types mirroring what the control plane actually returns.
 *
 * The previous version of this file described a different product: an
 * `Environment` resource that no endpoint serves, a `Run` with two fields, an
 * `EvidenceBundle` with no evidence in it. Every one of them typechecked
 * cleanly and none of them matched a response.
 *
 * Note the absence of a model list and a provider enum. Both are server-side
 * facts, discovered at runtime; an SDK that shipped them would be wrong on the
 * day a provider released a model and would keep compiling.
 */

/** RFC 9457 problem+json. Every error from the control plane has this shape. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Which input was at fault, when the server can say. */
  field?: string;
}

export class AgentEvalError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'AgentEvalError';
  }
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  tenantId: string;
  status: RunStatus;
  /** The full reproducibility record. Hashed into every evidence bundle. */
  manifest: Record<string, unknown>;
  retentionRules: string[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  /** A run that failed can always say why. */
  failureReason?: string;
  /** A reference to a stored credential, never a secret. */
  credentialId?: string;
}

export interface StartRunInput {
  environmentId: string;
  /** A digest, not a tag: a tag can move and the run would not be re-creatable. */
  environmentDigest: string;
  taskSetId: string;
  taskSetVersion: string;
  split: string;
  verifierId: string;
  verifierVersion: string;
  model: {
    /** "<provider>/<model-id>". Any id the provider accepts is valid. */
    identifier: string;
    sampling: Record<string, unknown>;
    providerVersion?: string;
  };
  /** Which stored credential to spend. A reference only. */
  credentialId?: string;
  /** null records that the run was deliberately unseeded. */
  seed: number | null;
  isolationBackend: string;
  toolchain: Record<string, string>;
  retentionRules: string[];
  budget?: { maxTokens?: number; maxCostUsd?: number; maxWallClockSeconds?: number };
}

export interface AuditEntry {
  seq: number;
  tenantId: string;
  actor: string;
  action: string;
  subject: string;
  payload: Record<string, unknown>;
  recordedAt: string;
  previousHash: string;
  entryHash: string;
}

export interface InclusionProof {
  leafIndex: number;
  treeSize: number;
  path: string[];
}

export interface EvidenceBundle {
  payload: {
    bundleId: string;
    tenantId: string;
    runId: string;
    manifest: Record<string, unknown>;
    manifestDigest: string;
    entries: AuditEntry[];
    logRoot: string;
    logSize: number;
    inclusionProofs: Record<number, InclusionProof>;
    mappings: { standard: string; article: string; claim: string; caveat?: string }[];
    retention: { retainUntil: string; policy: string; wormAnchored: boolean };
    generatedAt: string;
  };
  signature: { algorithm: string; keyId: string; value: string; signedAt: string };
}

export interface BundleVerification {
  valid: boolean;
  checks: {
    signature: boolean;
    chain: boolean;
    inclusion: boolean;
    manifest: boolean;
    retention: boolean;
  };
  failures: string[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'escalated' | 'expired';

export interface Approval {
  id: string;
  runId: string;
  action: string;
  status: ApprovalStatus;
  deadline: string;
  onTimeout: 'deny' | 'allow';
  trajectoryContext: { trialId: string; throughStep: number };
}

// ------------------------------------------------------------------ providers

export type Support = 'supported' | 'unsupported' | 'unknown';

/** 'unknown' is a real answer: the provider does not say, so neither do we. */
export interface ProviderCapabilities {
  streaming: Support;
  tools: Support;
  jsonMode: Support;
  vision: Support;
  systemPrompt: Support;
  logprobs: Support;
  reasoningEffort: Support;
}

export interface ProviderCredential {
  id: string;
  providerId: string;
  name: string;
  /** Enough to recognise the key, never enough to use it. */
  masked: string;
  baseUrl?: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface ProviderSummary {
  id: string;
  displayName: string;
  requiresApiKey: boolean;
  /** True when listing is worth attempting; 'unknown' counts. */
  supportsModelListing: boolean;
  /** The provider's own claim, 'unknown' preserved. */
  modelListing: Support;
  capabilities: ProviderCapabilities;
  credentialConfigured: boolean;
  credentials: Pick<ProviderCredential, 'id' | 'name' | 'masked' | 'lastUsedAt'>[];
}

/**
 * The result of a request that actually happened. There is no default and no
 * 'unknown' member: a provider that has not been tested has no status at all,
 * which the SDK expresses by not having called `testProvider`.
 */
export type ConnectionStatus =
  | { status: 'connected'; detail?: string; modelCount?: number }
  | { status: 'not_configured'; detail: string }
  | { status: 'authentication_failed'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'error'; detail: string };

export interface ModelInfo {
  id: string;
  displayName?: string;
  provider: string;
  contextLength?: number;
  metadata?: Record<string, unknown>;
}

export interface ModelListing {
  items: ModelInfo[];
  /** False where the provider exposes no enumeration API at all. */
  listingSupported: boolean;
  fetchedAt?: string;
  note?: string;
}

export interface Identity {
  actor: string;
  tenantId: string;
  scopes: string[];
  authentication: 'bearer';
}

export interface ApiKey {
  id: string;
  tenantId: string;
  createdBy: string;
  name: string;
  description?: string;
  masked: string;
  last4: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}
