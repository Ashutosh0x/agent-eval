/**
 * Client for the control plane.
 *
 * The token lives in localStorage because a browser cannot set an
 * Authorization header from the address bar — which is the whole reason a
 * dashboard exists rather than expecting people to use curl. In production
 * this is an OIDC flow; the shape of what it produces is the same.
 */

const TOKEN_KEY = 'agent-eval.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export const DEV_TOKEN =
  'acme:you@example.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  field?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }
}

/**
 * Where the control plane lives.
 *
 * Empty in development, where Vite proxies /v1 to localhost:8080. In a
 * deployed build there is no proxy, so the origin has to come from
 * configuration — and it is a VITE_ variable precisely because it is public:
 * the API base URL is visible in every network request the browser makes
 * anyway. Nothing secret may ever be added here.
 *
 * A trailing slash is stripped so `${BASE}/v1/runs` cannot become a double
 * slash, which some proxies treat as a different path.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!res.ok) {
    let problem: Problem;
    try {
      problem = (await res.json()) as Problem;
    } catch {
      problem = { type: 'about:blank', title: res.statusText, status: res.status };
    }
    throw new ApiError(problem);
  }

  return (await res.json()) as T;
}

// ------------------------------------------------------------------- types

export interface AuditEntry {
  seq: number;
  recordedAt: string;
  action: string;
  actor: string;
  tenantId: string;
  subject: string | null;
  payload: Record<string, unknown>;
  previousHash: string;
  entryHash: string;
}

export interface RunRecord {
  id: string;
  status: string;
  manifest: {
    runId: string;
    environment: { reference: string; digest: string };
    model: { identifier: string; sampling: Record<string, unknown> };
    taskSet: { id: string; version: string; split: string; splitHash: string };
    verifier: { id: string; version: string };
    seed: number | null;
    isolationBackend: string;
    toolchain: Record<string, string>;
    createdAt: string;
  };
  retentionRules: string[];
  createdAt: string;
}

export type MappingStrength = 'satisfies' | 'supports' | 'exceeds';

export interface ArticleMapping {
  provision: string;
  requirement: string;
  strength: MappingStrength;
  evidence: string;
  caveat?: string;
}

export interface BundlePayload {
  bundleId: string;
  runId: string;
  manifest: RunRecord['manifest'];
  manifestDigest: string;
  entries: AuditEntry[];
  logRoot: string;
  logSize: number;
  inclusionProofs: Record<number, { leafIndex: number; treeSize: number; path: string[] }>;
  mappings: ArticleMapping[];
  retention: { retainUntil: string; policy: string; wormAnchored: boolean };
  generatedAt: string;
}

export interface EvidenceBundle {
  payload: BundlePayload;
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

export interface Identity {
  actor: string;
  tenantId: string;
  scopes: string[];
  authentication: 'bearer';
  availableScopes: {
    scope: string;
    description: string;
    consequential: boolean;
    held: boolean;
  }[];
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
  revokedAt?: string;
  revokedBy?: string;
  lastUsedAt?: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  action: string;
  status: string;
  deadline: string;
  onTimeout: 'deny' | 'allow';
  trajectoryContext: { trialId: string; throughStep: number };
  decidedBy?: string;
  decidedAt?: string;
  rationale?: string;
}

// ---------------------------------------------------------------- endpoints


// ------------------------------------------------------------------ providers

/**
 * Note what is absent: there is no model list in this file, and no hardcoded
 * provider catalogue. Both come from the server, which gets them from the
 * providers themselves. A list shipped in the frontend would be wrong within
 * days of any provider release, and would be wrong silently.
 */
export interface ProviderCapabilities {
  streaming: Support;
  tools: Support;
  jsonMode: Support;
  vision: Support;
  systemPrompt: Support;
  logprobs: Support;
  reasoningEffort: Support;
}

/** 'unknown' is a real answer: the provider does not say, so neither do we. */
export type Support = 'supported' | 'unsupported' | 'unknown';

export interface ProviderCredential {
  id: string;
  providerId: string;
  name: string;
  /** Enough to recognise the key. Never enough to use it. */
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
  /** True when listing is worth attempting -- 'unknown' counts, since a failed probe is information. */
  supportsModelListing: boolean;
  /** The provider's own claim, with 'unknown' preserved rather than folded into false. */
  modelListing: Support;
  capabilities: ProviderCapabilities;
  /** From stored credentials or environment, never asserted. */
  credentialConfigured: boolean;
  credentials: Pick<ProviderCredential, 'id' | 'name' | 'masked' | 'lastUsedAt'>[];
}

/**
 * The outcome of a real request. There is deliberately no default value: a
 * provider that has not been tested has no status, rather than a green one.
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
}

export interface ModelListing {
  items: ModelInfo[];
  /** False where the provider exposes no enumeration API at all. */
  listingSupported: boolean;
  fetchedAt?: string;
  note?: string;
}


// --------------------------------------------------------------------- system

/**
 * A measured fact, or the reason it could not be measured.
 *
 * The UI must render 'unavailable' as unavailable. A probe that could not run
 * is not a zero, and showing it as one turns a missing tool into a reading.
 */
export type SystemProbe<T> =
  | { status: 'ok'; value: T }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; reason: string };

export interface GpuDevice {
  name: string;
  computeCapability?: string;
  memoryTotalMiB?: number;
  driverVersion?: string;
}

export interface SystemCapabilities {
  platform: string;
  architecture: string;
  isArm64: boolean;
  kernel: string;
  cpu: { model?: string; cores: number };
  memory: { totalBytes: number; freeBytes: number; unified: SystemProbe<boolean> };
  gpu: SystemProbe<GpuDevice[]>;
  cuda: SystemProbe<string>;
  driver: SystemProbe<string>;
  docker: SystemProbe<string>;
  nvidiaContainerRuntime: SystemProbe<boolean>;
  os: SystemProbe<string>;
  dgxSpark: {
    detected: boolean;
    /** Why the verdict went the way it did, so it can be checked. */
    evidence: string[];
    target: 'local' | 'docker' | 'dgx-spark' | 'server' | 'unknown';
  };
  detectedAt: string;
}

export interface SystemHealth {
  summary: string;
  deploymentTarget: string;
  dgxSpark: boolean;
  components: Record<string, { status: 'ok' | 'unavailable' | 'unknown'; detail: string }>;
  checkedAt: string;
}

export interface RuntimeStatus {
  id: string;
  displayName: string;
  locality: 'local' | 'remote';
  dgxSpark: { support: 'documented' | 'unsupported' | 'unknown'; note: string };
  requiresBaseUrl: boolean;
  defaultPort?: number;
  /** An operator set an endpoint. Says nothing about whether it answered. */
  configured: boolean;
  baseUrl?: string;
  connection: ConnectionStatus | { status: 'not_tested'; detail: string };
  platformNote: string;
}

export const api = {
  discovery: () => request<Record<string, unknown>>('/v1'),

  health: () => request<{ status: string }>('/v1/health'),

  me: () => request<Identity>('/v1/me'),

  runs: {
    list: () => request<{ items: RunRecord[] }>('/v1/runs'),
    get: (id: string) => request<RunRecord>(`/v1/runs/${id}`),
    manifest: (id: string) => request<RunRecord['manifest']>(`/v1/runs/${id}/manifest`),
    start: (body: unknown) =>
      request<{ runId: string; status: string }>('/v1/runs', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    cancel: (id: string) =>
      request<RunRecord>(`/v1/runs/${id}/cancel`, { method: 'POST' }),
    compare: (runA: string, runB: string) =>
      request<{ comparable: boolean; differences: string[]; note?: string }>('/v1/runs/compare', {
        method: 'POST',
        body: JSON.stringify({ runA, runB }),
      }),
  },

  approvals: {
    list: (status?: string) =>
      request<{ items: ApprovalRecord[] }>(
        `/v1/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`,
      ),
    decide: (id: string, decision: string, rationale: string) =>
      request<ApprovalRecord>(`/v1/approvals/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, rationale }),
      }),
  },

  apiKeys: {
    list: () => request<{ items: ApiKey[] }>('/v1/api-keys'),
    get: (id: string) => request<ApiKey>(`/v1/api-keys/${id}`),
    // The only call that ever receives a plaintext secret.
    create: (name: string, scopes: string[], description?: string, expiresInDays?: number) =>
      request<{ key: ApiKey; secret: string }>('/v1/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name,
          scopes,
          ...(description ? { description } : {}),
          ...(expiresInDays ? { expiresInDays } : {}),
        }),
      }),
    revoke: (id: string) => request<ApiKey>(`/v1/api-keys/${id}/revoke`, { method: 'POST' }),
  },

  providers: {
    list: () =>
      request<{ encryptionConfigured: boolean; items: ProviderSummary[] }>('/v1/providers'),
    /** Performs an actual request. Slow on purpose; the result is real. */
    test: (providerId: string, credentialId?: string) =>
      request<ConnectionStatus>('/v1/providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId, ...(credentialId ? { credentialId } : {}) }),
      }),
    models: (providerId: string, credentialId?: string) =>
      request<ModelListing>(
        `/v1/providers/${encodeURIComponent(providerId)}/models${
          credentialId ? `?credentialId=${encodeURIComponent(credentialId)}` : ''
        }`,
      ),
  },

  /**
   * Provider credentials. Note there is no `get` that returns a secret and no
   * reveal method — the API has no such route, so the client cannot have one
   * even by accident.
   */
  credentials: {
    list: () => request<{ items: ProviderCredential[] }>('/v1/provider-credentials'),
    create: (body: { providerId: string; name: string; apiKey?: string; baseUrl?: string }) =>
      request<ProviderCredential>('/v1/provider-credentials', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    revoke: (id: string) =>
      request<ProviderCredential>(`/v1/provider-credentials/${id}/revoke`, { method: 'POST' }),
  },

  system: {
    capabilities: () => request<SystemCapabilities>('/v1/system/capabilities'),
    health: () => request<SystemHealth>('/v1/system/health'),
    runtimes: () =>
      request<{ items: RuntimeStatus[]; host: { target: string; isArm64: boolean } }>(
        '/v1/system/runtimes',
      ),
    gpu: () =>
      request<{
        devices: SystemProbe<GpuDevice[]>;
        telemetry: SystemProbe<
          { utilizationPercent?: number; memoryUsedMiB?: number; temperatureCelsius?: number; powerDrawWatts?: number }[]
        >;
        sampledAt: string;
      }>('/v1/system/gpu'),
  },

  audit: {
    list: () => request<{ items: AuditEntry[] }>('/v1/audit'),
    root: () => request<{ root: string; size: number }>('/v1/audit/root'),
    get: (seq: number) => request<AuditEntry>(`/v1/audit/${seq}`),
    consistencyProof: (from: number) =>
      request<{
        proof: { firstSize: number; secondSize: number; path: string[] };
        currentRoot: string;
        currentSize: number;
      }>(`/v1/audit/consistency-proof?from=${from}`),
    inclusionProof: (seq: number) =>
      request<{
        proof: { leafIndex: number; treeSize: number; path: string[] };
        leaf: string;
        root: string;
      }>(`/v1/audit/${seq}/inclusion-proof`),
    verify: () =>
      request<{ valid: boolean; brokenAt?: number; reason?: string }>('/v1/audit/verify', {
        method: 'POST',
      }),
  },

  evidence: {
    // No auth: an auditor must be able to verify a signature without an
    // account on the system that produced it.
    keys: () =>
      request<{ keys: { keyId: string; algorithm: string; publicKeyPem: string }[] }>(
        '/v1/evidence/keys',
      ),
    generate: (runId: string, retentionRules: string[]) =>
      request<{ bundleId: string; bundle: EvidenceBundle }>('/v1/evidence/bundles', {
        method: 'POST',
        body: JSON.stringify({ runId, retentionRules }),
      }),
    get: (id: string) => request<EvidenceBundle>(`/v1/evidence/bundles/${id}`),
    verify: (id: string) =>
      request<BundleVerification>(`/v1/evidence/bundles/${id}/verify`, { method: 'POST' }),
    offline: (id: string) =>
      request<{
        bundle: EvidenceBundle;
        publicKeyPem: string;
        keyId: string;
        instructions: { signature: string; merkle: string[]; chain: string };
      }>(`/v1/evidence/bundles/${id}/offline`),
  },
};
