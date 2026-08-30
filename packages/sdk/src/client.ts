/**
 * Client for the agent-eval control plane.
 *
 * Rewritten against the routes the server actually serves. The previous
 * version called `/environments`, `/runs/:id/stop`, `/evidence`,
 * `/audit/verify-chain` and `/approvals/:id/approve` — none of which exist,
 * and none with the `/v1` prefix every real route carries. It compiled, it
 * typechecked, and every call would have 404ed.
 *
 * Two things this client will not do, both deliberate:
 *
 *   It never calls a model provider. Provider credentials live on the server
 *   and are decrypted there; an SDK that talked to OpenAI directly would need
 *   the caller to hold the key, which is the arrangement the control plane
 *   exists to replace.
 *
 *   It never returns a provider secret, because no endpoint returns one. The
 *   masked form is the only representation that crosses the wire.
 */

import {
  AgentEvalError,
  type ApiKey,
  type Approval,
  type AuditEntry,
  type BundleVerification,
  type ConnectionStatus,
  type EvidenceBundle,
  type Identity,
  type InclusionProof,
  type ModelListing,
  type Problem,
  type ProviderCredential,
  type ProviderSummary,
  type Run,
  type StartRunInput,
} from './types';

export interface ClientOptions {
  /** e.g. http://127.0.0.1:8080 */
  baseUrl: string;
  /** An agent-eval API key (ae_live_…) or a development token. */
  apiKey: string;
  /** Defaults to the global fetch, which Node has had since 18. */
  fetch?: typeof globalThis.fetch;
}

export class AgentEvalClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('No fetch implementation available. Pass one via options.fetch.');
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        // Only when there is a body. Declaring application/json on a bodyless
        // POST makes Fastify reject it with "Body cannot be empty", which
        // broke every revoke, cancel and verify call — the ones that need no
        // input at all.
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });

    if (!res.ok) {
      // The server speaks problem+json, which carries a reason and often the
      // offending field. Collapsing that into "API error: 422" throws away
      // the only part a caller can act on.
      let problem: Problem;
      try {
        problem = (await res.json()) as Problem;
      } catch {
        problem = { type: 'about:blank', title: res.statusText, status: res.status };
      }
      throw new AgentEvalError(problem);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private query(params: Record<string, string | number | undefined>): string {
    const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
    if (pairs.length === 0) return '';
    return '?' + pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  }

  /** Who this credential says you are, and what it may do. */
  me(): Promise<Identity> {
    return this.request('/v1/me');
  }

  health(): Promise<{ status: string }> {
    return this.request('/v1/health');
  }

  /** Whether the deployment can actually execute a run, and why not if it cannot. */
  ready(): Promise<Record<string, unknown>> {
    return this.request('/v1/ready');
  }

  runs = {
    list: (): Promise<{ items: Run[] }> => this.request('/v1/runs'),

    get: (id: string): Promise<Run> => this.request(`/v1/runs/${encodeURIComponent(id)}`),

    manifest: (id: string): Promise<Record<string, unknown>> =>
      this.request(`/v1/runs/${encodeURIComponent(id)}/manifest`),

    /** The run's own audit entries, in order. */
    entries: (id: string): Promise<{ items: AuditEntry[] }> =>
      this.request(`/v1/runs/${encodeURIComponent(id)}/entries`),

    /**
     * Queue a run. Returns immediately; a worker claims it.
     *
     * The server refuses a manifest it could not reproduce, so a rejection
     * here is usually a missing field rather than a transient failure — the
     * thrown AgentEvalError names it.
     */
    start: (input: StartRunInput): Promise<{ runId: string; status: string }> =>
      this.request('/v1/runs', { method: 'POST', body: JSON.stringify(input) }),

    cancel: (id: string): Promise<Run> =>
      this.request(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

    compare: (runA: string, runB: string): Promise<{
      comparable: boolean;
      differences: string[];
      note?: string;
    }> => this.request('/v1/runs/compare', { method: 'POST', body: JSON.stringify({ runA, runB }) }),
  };

  providers = {
    /**
     * Registered providers and whether each has a credential.
     *
     * `credentialConfigured` is not a connection status: it says a key exists,
     * not that it works. Use `test` for the second question.
     */
    list: (): Promise<{ encryptionConfigured: boolean; items: ProviderSummary[] }> =>
      this.request('/v1/providers'),

    /** Performs a real request against the provider. Never a canned answer. */
    test: (providerId: string, credentialId?: string): Promise<ConnectionStatus> =>
      this.request('/v1/providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId, ...(credentialId ? { credentialId } : {}) }),
      }),

    /**
     * Ask the provider what models it has.
     *
     * There is no local fallback list. When a provider exposes no enumeration
     * API the response says so via `listingSupported: false`, and any model id
     * the provider accepts remains usable in `runs.start`.
     */
    models: (providerId: string, credentialId?: string): Promise<ModelListing> =>
      this.request(
        `/v1/providers/${encodeURIComponent(providerId)}/models${this.query({ credentialId })}`,
      ),
  };

  /**
   * Provider credentials.
   *
   * There is deliberately no `reveal` and no `get` returning a secret: the API
   * has no such route, so the SDK cannot grow one by accident.
   */
  credentials = {
    list: (): Promise<{ items: ProviderCredential[] }> => this.request('/v1/provider-credentials'),

    /**
     * Store a credential. The plaintext travels once, over TLS, and is
     * encrypted before it is written. Nothing returns it afterwards.
     */
    create: (input: {
      providerId: string;
      name: string;
      apiKey?: string;
      baseUrl?: string;
    }): Promise<ProviderCredential> =>
      this.request('/v1/provider-credentials', { method: 'POST', body: JSON.stringify(input) }),

    revoke: (id: string): Promise<ProviderCredential> =>
      this.request(`/v1/provider-credentials/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  };

  evidence = {
    /** Sign a bundle over one run's audit entries. */
    generate: (runId: string, retentionRules: string[]): Promise<{
      bundleId: string;
      bundle: EvidenceBundle;
    }> =>
      this.request('/v1/evidence/bundles', {
        method: 'POST',
        body: JSON.stringify({ runId, retentionRules }),
      }),

    get: (id: string): Promise<EvidenceBundle> =>
      this.request(`/v1/evidence/bundles/${encodeURIComponent(id)}`),

    /**
     * Server-side verification, for convenience.
     *
     * An auditor should not rely on this: it asks the system that produced the
     * bundle whether the bundle is good. Use `offline` and verify with a
     * public key instead.
     */
    verify: (id: string): Promise<BundleVerification> =>
      this.request(`/v1/evidence/bundles/${encodeURIComponent(id)}/verify`, { method: 'POST' }),

    /** The bundle plus the public key, verifiable with no network access. */
    offline: (id: string): Promise<{
      bundle: EvidenceBundle;
      publicKeyPem: string;
      keyId: string;
      instructions: string;
    }> => this.request(`/v1/evidence/bundles/${encodeURIComponent(id)}/offline`),

    keys: (): Promise<{
      keys: { keyId: string; algorithm: string; publicKeyPem: string }[];
    }> => this.request('/v1/evidence/keys'),
  };

  audit = {
    query: (filters: {
      actor?: string;
      action?: string;
      subject?: string;
      cursor?: string;
      limit?: number;
    } = {}): Promise<{ items: AuditEntry[]; nextCursor?: string }> =>
      this.request(`/v1/audit${this.query(filters)}`),

    get: (seq: number): Promise<AuditEntry> => this.request(`/v1/audit/${seq}`),

    root: (): Promise<{ root: string; size: number }> => this.request('/v1/audit/root'),

    /**
     * Verifies the chain across the whole log, not a slice of it.
     *
     * POST rather than GET because it is a potentially expensive scan of every
     * entry, not a cheap read. Calling it as a GET lands on /v1/audit/:seq
     * with seq="verify" instead.
     */
    verify: (): Promise<{ valid: boolean; brokenAt?: number; reason?: string }> =>
      this.request('/v1/audit/verify', { method: 'POST' }),

    /** The proof, plus the leaf and root it is against, so it is checkable alone. */
    inclusionProof: (
      seq: number,
    ): Promise<{ proof: InclusionProof; leaf: string; root: string }> =>
      this.request(`/v1/audit/${seq}/inclusion-proof`),

    /** Proves an earlier root is a prefix of a later one; append-only evidence. */
    consistencyProof: (first: number, second: number): Promise<{ path: string[] }> =>
      this.request(`/v1/audit/consistency-proof${this.query({ first, second })}`),
  };

  approvals = {
    list: (status?: string): Promise<{ items: Approval[] }> =>
      this.request(`/v1/approvals${this.query({ status })}`),

    /**
     * One endpoint, not three. A rationale is mandatory for every outcome,
     * including approval — an unexplained approval is not oversight.
     */
    decide: (
      id: string,
      decision: 'approved' | 'rejected' | 'escalated',
      rationale: string,
    ): Promise<Approval> =>
      this.request(`/v1/approvals/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, rationale }),
      }),
  };

  apiKeys = {
    list: (): Promise<{ items: ApiKey[] }> => this.request('/v1/api-keys'),

    get: (id: string): Promise<ApiKey> => this.request(`/v1/api-keys/${encodeURIComponent(id)}`),

    /**
     * The only call that ever receives a plaintext secret, and only once. The
     * server stores a hash and cannot reissue it.
     */
    create: (input: {
      name: string;
      scopes: string[];
      description?: string;
      expiresInDays?: number;
    }): Promise<{ key: ApiKey; secret: string }> =>
      this.request('/v1/api-keys', { method: 'POST', body: JSON.stringify(input) }),

    revoke: (id: string): Promise<ApiKey> =>
      this.request(`/v1/api-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  };
}
