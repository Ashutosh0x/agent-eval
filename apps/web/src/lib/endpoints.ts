/**
 * Endpoint reference.
 *
 * Transcribed from the Fastify route registrations in
 * packages/server/src/api/app.ts, not invented. The OpenAPI document at
 * /docs/json remains the source of truth — this exists so the reference is
 * browsable inside the product without leaving for Swagger, and so a scope
 * column can sit next to each route, which OpenAPI has no natural place for.
 *
 * If these drift, the OpenAPI document wins.
 */

export type HttpMethod = 'GET' | 'POST';

export interface EndpointDoc {
  method: HttpMethod;
  path: string;
  summary: string;
  /** Null where the route is deliberately public. */
  scope: string | null;
  auth: boolean;
  group: 'System' | 'Runs' | 'Approvals' | 'Evidence' | 'Audit' | 'Authentication';
  detail?: string;
  /** True where the route exists but no screen calls it. */
  backendOnly?: boolean;
}

export const ENDPOINTS: readonly EndpointDoc[] = [
  // ------------------------------------------------------------------ system
  {
    method: 'GET',
    path: '/v1',
    summary: 'Discovery root',
    scope: null,
    auth: false,
    group: 'System',
    detail:
      'Lists every endpoint, the seven scopes, and the development token format. Public because a 401 that cannot tell you how to authenticate is a dead end.',
  },
  {
    method: 'GET',
    path: '/v1/health',
    summary: 'Liveness',
    scope: null,
    auth: false,
    group: 'System',
  },

  // ---------------------------------------------------------- authentication
  {
    method: 'GET',
    path: '/v1/me',
    summary: 'The caller identity this token carries',
    scope: null,
    auth: true,
    group: 'Authentication',
    detail:
      'Actor, tenant, held scopes, and every scope the control plane recognises. The dashboard renders permissions from this rather than parsing the token, so the server stays authoritative.',
  },
  {
    method: 'GET',
    path: '/v1/api-keys',
    summary: 'List API keys',
    scope: 'runs:read',
    auth: true,
    group: 'Authentication',
    detail: 'Metadata and a masked identifier only. The secret is not stored, so it cannot be returned.',
  },
  {
    method: 'POST',
    path: '/v1/api-keys',
    summary: 'Create an API key',
    scope: 'runs:write',
    auth: true,
    group: 'Authentication',
    detail:
      'The only response that carries a plaintext secret. Cannot mint a key more capable than the caller.',
  },
  {
    method: 'GET',
    path: '/v1/api-keys/{id}',
    summary: 'Read one API key',
    scope: 'runs:read',
    auth: true,
    group: 'Authentication',
  },
  {
    method: 'POST',
    path: '/v1/api-keys/{id}/revoke',
    summary: 'Revoke an API key',
    scope: 'runs:write',
    auth: true,
    group: 'Authentication',
    detail: 'Marks revoked rather than deleting; the record evidences that the credential existed.',
  },

  // -------------------------------------------------------------------- runs
  {
    method: 'GET',
    path: '/v1/runs',
    summary: 'List evaluation runs',
    scope: 'runs:read',
    auth: true,
    group: 'Runs',
  },
  {
    method: 'POST',
    path: '/v1/runs',
    summary: 'Start a run',
    scope: 'runs:write',
    auth: true,
    group: 'Runs',
    detail:
      'Returns 202. Validates the manifest first: a run that cannot say what it ran produces a number, not evidence.',
  },
  {
    method: 'GET',
    path: '/v1/runs/{id}',
    summary: 'Read one run',
    scope: 'runs:read',
    auth: true,
    group: 'Runs',
  },
  {
    method: 'GET',
    path: '/v1/runs/{id}/manifest',
    summary: 'Reproducibility manifest',
    scope: 'runs:read',
    auth: true,
    group: 'Runs',
    detail: 'Pinned image digest, split hash, model, sampling, seed, verifier and toolchain.',
  },
  {
    method: 'POST',
    path: '/v1/runs/{id}/cancel',
    summary: 'Cancel a run',
    scope: 'runs:write',
    auth: true,
    group: 'Runs',
  },
  {
    method: 'POST',
    path: '/v1/runs/compare',
    summary: 'Comparability verdict between two runs',
    scope: 'runs:read',
    auth: true,
    group: 'Runs',
    detail:
      'Answers whether a score moved because the agent changed or because something underneath did.',
  },

  // --------------------------------------------------------------- approvals
  {
    method: 'GET',
    path: '/v1/approvals',
    summary: 'Approval queue',
    scope: 'runs:read',
    auth: true,
    group: 'Approvals',
    detail: 'The EU AI Act Art. 14 surface. Each item states what happens if nobody acts.',
  },
  {
    method: 'POST',
    path: '/v1/approvals/{id}/decide',
    summary: 'Decide a gated action',
    scope: 'approvals:decide',
    auth: true,
    group: 'Approvals',
    detail:
      'A rationale is required on every decision including approve — an approval with no recorded reason evidences a click, not oversight.',
  },

  // ---------------------------------------------------------------- evidence
  {
    method: 'POST',
    path: '/v1/evidence/bundles',
    summary: 'Generate and sign a bundle',
    scope: 'evidence:generate',
    auth: true,
    group: 'Evidence',
  },
  {
    method: 'GET',
    path: '/v1/evidence/bundles/{id}',
    summary: 'Read a bundle',
    scope: 'evidence:read',
    auth: true,
    group: 'Evidence',
  },
  {
    method: 'POST',
    path: '/v1/evidence/bundles/{id}/verify',
    summary: 'Server-side re-check',
    scope: 'evidence:read',
    auth: true,
    group: 'Evidence',
  },
  {
    method: 'GET',
    path: '/v1/evidence/bundles/{id}/offline',
    summary: 'Self-contained verification kit',
    scope: 'evidence:read',
    auth: true,
    group: 'Evidence',
    detail:
      'Bundle, public key and the RFC 6962 formulas — enough to check the evidence on an air-gapped machine.',
  },
  {
    method: 'GET',
    path: '/v1/evidence/keys',
    summary: 'Public signing keys',
    scope: null,
    auth: false,
    group: 'Evidence',
    detail:
      'Unauthenticated on purpose. Requiring a login to check a signature would make the signature meaningless.',
  },

  // ------------------------------------------------------------------- audit
  {
    method: 'GET',
    path: '/v1/audit',
    summary: 'Query the audit log',
    scope: 'audit:read',
    auth: true,
    group: 'Audit',
  },
  {
    method: 'GET',
    path: '/v1/audit/root',
    summary: 'Current Merkle root',
    scope: 'audit:read',
    auth: true,
    group: 'Audit',
    detail: 'Publish or anchor this. A later consistency proof then makes tampering provable.',
  },
  {
    method: 'GET',
    path: '/v1/audit/{seq}',
    summary: 'Read one entry',
    scope: 'audit:read',
    auth: true,
    group: 'Audit',
  },
  {
    method: 'GET',
    path: '/v1/audit/{seq}/inclusion-proof',
    summary: 'Prove one entry is in the log',
    scope: 'audit:read',
    auth: true,
    group: 'Audit',
    detail:
      'The leaf is the entry hash, not the payload, so membership is provable without disclosing contents.',
  },
  {
    method: 'GET',
    path: '/v1/audit/consistency-proof',
    summary: 'Prove the log only ever grew',
    scope: 'audit:read',
    auth: true,
    group: 'Audit',
    backendOnly: true,
    detail:
      'Requires a previously published root to compare against, which no screen holds yet. Reachable from the client and from curl.',
  },
  {
    method: 'POST',
    path: '/v1/audit/verify',
    summary: 'Recompute the whole chain',
    scope: 'audit:read',
    auth: true,
    group: 'Audit',
    detail: 'Returns the sequence number of the first bad entry, not just a boolean.',
  },
] as const;

export const ENDPOINT_GROUPS = [
  'Runs',
  'Evidence',
  'Approvals',
  'Audit',
  'Authentication',
  'System',
] as const;
