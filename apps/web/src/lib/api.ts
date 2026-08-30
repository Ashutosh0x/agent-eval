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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
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
    create: (name: string, scopes: string[], description?: string) =>
      request<{ key: ApiKey; secret: string }>('/v1/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name, scopes, ...(description ? { description } : {}) }),
      }),
    revoke: (id: string) => request<ApiKey>(`/v1/api-keys/${id}/revoke`, { method: 'POST' }),
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
