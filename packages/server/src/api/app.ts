/**
 * The control-plane HTTP API.
 *
 * Built around one rule, which is where most of the odd shapes come from:
 * anything a regulator might need to check must be reachable without trusting
 * this server. That is why the public-key endpoint takes no auth, why proofs
 * are first-class routes, and why there is no way to delete an audit entry.
 *
 * See docs/api.md for the full surface and the run flow.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  Signer,
  createBundle,
  resolveRetention,
  verifyBundle,
  verifyInclusion,
  verifyConsistency,
  createManifest,
  hashSplit,
  type EvidenceBundle,
} from '../evidence/index.js';
import {
  approvalDecisionSchema,
  auditQuerySchema,
  compareRunsSchema,
  consistencyQuerySchema,
  cursorSchema,
  createApiKeySchema,
  generateBundleSchema,
  problem,
  problemFromZod,
  startRunSchema,
} from '../schemas/index.js';
import type { InMemoryAuditStore, Stores, TenantContext } from '../store/index.js';
import { registerDocs } from './docs.js';
import type { RunWorker } from '../worker/worker.js';
import {
  ALL_SCOPES,
  ApiKeyError,
  CONSEQUENTIAL_SCOPES,
  InMemoryApiKeyStore,
  SCOPE_DESCRIPTIONS,
  type ApiKeyStore,
  type Scope,
} from '../auth/api-keys.js';

export interface AppOptions {
  stores: Stores & { audit: InMemoryAuditStore };
  signer: Signer;
  /** Resolves a bearer token to a caller. Swap for real OIDC in production. */
  authenticate?: (token: string | undefined) => TenantContext | null;
  logger?: boolean;
  /** Serve OpenAPI + Swagger UI at /docs. Default true. */
  docs?: boolean;
  /** Where API keys live. Defaults to an in-memory store. */
  apiKeys?: ApiKeyStore;
  /** The run worker, if one is attached. Reported by /v1/ready. */
  worker?: RunWorker;
  /** Why execution is unavailable, when it is. */
  executionUnavailable?: string | null;
}

/**
 * Development-only auth: `Bearer <tenant>:<actor>:<scope,scope>`.
 *
 * Split on the first two colons only. Scope names contain colons themselves
 * (`runs:read`), so a plain `split(':')` silently truncates every scope to its
 * first segment and turns `runs:read` into `runs` -- which then fails every
 * authorization check with a 403 that looks like a permissions problem rather
 * than a parsing one.
 */
function devAuthenticate(token: string | undefined): TenantContext | null {
  if (!token) return null;
  const firstColon = token.indexOf(':');
  const secondColon = token.indexOf(':', firstColon + 1);
  if (firstColon < 1 || secondColon < 0) return null;

  const tenantId = token.slice(0, firstColon);
  const actor = token.slice(firstColon + 1, secondColon);
  const scopes = token.slice(secondColon + 1);
  if (!tenantId || !actor) return null;

  return { tenantId, actor, scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean) };
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: TenantContext;
  }
}

let idCounter = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/**
 * Async because the OpenAPI plugin installs an onRoute hook, and it has to be
 * in place before any route is registered or it captures nothing.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { stores, signer } = options;
  const authenticate = options.authenticate ?? devAuthenticate;
  const apiKeys = options.apiKeys ?? new InMemoryApiKeyStore();

  const app = Fastify({ logger: options.logger ?? false });

  if (options.docs !== false) {
    await registerDocs(app);
  }

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      const p = problemFromZod(error);
      return reply.status(p.status).type('application/problem+json').send(p);
    }
    const err = error as { statusCode?: number; message?: string };
    const status = err.statusCode ?? 500;
    // A 500's message is never echoed back: it can carry internals, and an
    // error page is a poor place to disclose them.
    const p = problem(
      status === 500 ? 'internal' : 'request-failed',
      status === 500 ? 'Internal error' : (err.message ?? 'Request failed'),
      status,
      status === 500 ? undefined : err.message,
    );
    return reply.status(status).type('application/problem+json').send(p);
  });

  /**
   * Auth. The public-key route is exempt on purpose: an auditor must be able
   * to verify a signature without an account on the system that produced it.
   */
  const PUBLIC_ROUTES = new Set(['/v1', '/v1/evidence/keys', '/v1/health', '/v1/ready']);

  /**
   * Prefixes served without a bearer token.
   *
   * /docs is the browsable UI and must be reachable from an address bar --
   * requiring the header a browser cannot send would defeat the point of it.
   * The UI then attaches that header to the calls it makes for you, so the
   * endpoints behind it stay protected.
   */
  const PUBLIC_PREFIXES = ['/docs', '/documentation'];

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (PUBLIC_ROUTES.has(path)) return;
    if (PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + '/'))) return;
    const header = req.headers.authorization;
    const ctx = authenticate(header?.replace(/^Bearer\s+/i, ''));
    if (!ctx) {
      // RFC 9110 §11.6.1: a 401 response MUST include WWW-Authenticate naming
      // the scheme. Without it a client cannot tell how to authenticate, and
      // conforming HTTP libraries will not retry.
      return reply
        .status(401)
        .header('WWW-Authenticate', 'Bearer realm="agent-eval"')
        .type('application/problem+json')
        .send(
          problem(
            'unauthenticated',
            'Authentication required',
            401,
            header
              ? 'The Authorization header could not be parsed. Expected: Bearer <token>.'
              : 'No Authorization header was sent. Open /docs in a browser to explore the API and paste a token, or see GET /v1 for the token format.',
          ),
        );
    }
    req.ctx = ctx;
  });

  function requireScope(req: FastifyRequest, scope: string): void {
    if (!req.ctx.scopes.includes(scope)) {
      const err = new Error(`missing required scope: ${scope}`) as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    }
  }

  // ------------------------------------------------------------------ health

  app.get('/v1/health', async () => ({ status: 'ok' }));

  /**
   * Readiness, which is a different question from liveness.
   *
   * /v1/health says the process is up. This says whether the deployment can
   * actually execute an evaluation — a control plane that accepts runs nobody
   * will ever claim is worse than one that refuses them, because the run sits
   * in `queued` looking like progress.
   */
  app.get('/v1/ready', async (_req, reply) => {
    const worker = options.worker?.status();
    const checks = {
      api: true,
      // In-memory: present but not durable, and it says so.
      storage: { available: true, durable: false, kind: 'in-memory' },
      worker: worker
        ? { attached: true, running: worker.running, workerId: worker.workerId,
            claimed: worker.claimed, completed: worker.completed, failed: worker.failed }
        : { attached: false },
      execution: options.executionUnavailable
        ? { available: false, reason: options.executionUnavailable }
        : { available: true },
    };

    const ready = Boolean(worker?.running) && !options.executionUnavailable;
    return reply.status(ready ? 200 : 503).send({
      ready,
      checks,
      ...(ready
        ? {}
        : {
            note: !worker
              ? 'No worker is attached: queued runs will never be claimed.'
              : options.executionUnavailable ??
                'The worker is attached but not running.',
          }),
    });
  });

  /**
   * Discovery root.
   *
   * Public, because a 401 that cannot tell you how to authenticate is a dead
   * end -- and the first thing anyone does with a new API is open it in a
   * browser. This is also where the development token format is documented,
   * since it is otherwise unguessable.
   */
  app.get('/v1', async () => ({
    service: 'agent-eval control plane',
    version: '1.0.0',
    authentication: {
      scheme: 'Bearer',
      production: 'OIDC access token',
      development:
        'Bearer <tenantId>:<actor>:<comma-separated scopes>. ' +
        'Example: Bearer acme:you@example.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read',
      scopes: [
        'runs:read',
        'runs:write',
        'evidence:read',
        'evidence:generate',
        'approvals:decide',
        'audit:read',
        'splits:held-out',
      ],
    },
    publicEndpoints: ['GET /v1', 'GET /v1/health', 'GET /v1/evidence/keys'],
    endpoints: {
      runs: ['POST /v1/runs', 'GET /v1/runs', 'GET /v1/runs/:id', 'GET /v1/runs/:id/manifest', 'POST /v1/runs/:id/cancel', 'POST /v1/runs/compare'],
      approvals: ['GET /v1/approvals', 'POST /v1/approvals/:id/decide'],
      evidence: ['POST /v1/evidence/bundles', 'GET /v1/evidence/bundles/:id', 'POST /v1/evidence/bundles/:id/verify', 'GET /v1/evidence/bundles/:id/offline', 'GET /v1/evidence/keys'],
      audit: ['GET /v1/audit', 'GET /v1/audit/root', 'GET /v1/audit/:seq', 'GET /v1/audit/:seq/inclusion-proof', 'GET /v1/audit/consistency-proof', 'POST /v1/audit/verify'],
    },
    docs: 'docs/api.md',
  }));

  // -------------------------------------------------------------------- runs

  app.post('/v1/runs', async (req, reply) => {
    requireScope(req, 'runs:write');
    const input = startRunSchema.parse(req.body);

    const runId = newId('run');

    // Validate the manifest before accepting. A run that cannot say what it
    // ran produces a number, not evidence, so this belongs at submission time
    // rather than at bundle time when it is too late to re-run.
    let manifest;
    try {
      manifest = createManifest({
        runId,
        environment: { reference: input.environmentId, digest: input.environmentDigest },
        model: input.model,
        taskSet: {
          id: input.taskSetId,
          version: input.taskSetVersion,
          split: input.split,
          splitHash: hashSplit([input.taskSetId, input.taskSetVersion, input.split]),
          taskCount: 1,
        },
        verifier: { id: input.verifierId, version: input.verifierVersion },
        seed: input.seed,
        toolchain: input.toolchain,
        isolationBackend: input.isolationBackend,
      });
    } catch (e) {
      const p = problem(
        'manifest-incomplete',
        'Run manifest is not reproducible',
        422,
        (e as Error).message,
      );
      return reply.status(422).type('application/problem+json').send(p);
    }

    // Fail before recording anything if the retention basis is unusable.
    try {
      resolveRetention(input.retentionRules);
    } catch (e) {
      const p = problem(
        'retention-unresolvable',
        'Retention rules cannot be resolved',
        422,
        (e as Error).message,
        'retentionRules',
      );
      return reply.status(422).type('application/problem+json').send(p);
    }

    const run = await stores.runs.create(req.ctx, {
      id: runId,
      status: 'queued',
      manifest: manifest as unknown as Record<string, unknown>,
      retentionRules: input.retentionRules,
      createdAt: new Date(),
    });

    await stores.audit.append(req.ctx, {
      action: 'run.started',
      subject: runId,
      payload: {
        environmentDigest: input.environmentDigest,
        model: input.model.identifier,
        isolationBackend: input.isolationBackend,
      },
    });

    // 202: a run is a long-lived session, not a resource that exists the
    // moment you ask for it.
    return reply.status(202).send({ runId: run.id, status: run.status });
  });

  app.get('/v1/runs', async (req) => {
    requireScope(req, 'runs:read');
    const q = cursorSchema.parse(req.query);
    return stores.runs.list(req.ctx, q);
  });

  /** Entries recorded against one run, in chain order. */
  app.get<{ Params: { id: string } }>('/v1/runs/:id/entries', async (req, reply) => {
    requireScope(req, 'audit:read');
    const run = await stores.runs.get(req.ctx, req.params.id);
    if (!run) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Run not found', 404));
    }
    const items = await stores.audit.entriesForSubject(req.ctx, req.params.id);
    // Both sequence spaces, named. `seq` is the global chain position; the
    // index within this run is a different number, and conflating them
    // produces nonsense like "4 of 1".
    return {
      items: items.map((e, i) => ({ ...e, runIndex: i + 1 })),
      total: items.length,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req, reply) => {
    requireScope(req, 'runs:read');
    const run = await stores.runs.get(req.ctx, req.params.id);
    if (!run) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Run not found', 404));
    }
    return run;
  });

  app.get<{ Params: { id: string } }>('/v1/runs/:id/manifest', async (req, reply) => {
    requireScope(req, 'runs:read');
    const run = await stores.runs.get(req.ctx, req.params.id);
    if (!run) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Run not found', 404));
    }
    return run.manifest;
  });

  app.post<{ Params: { id: string } }>('/v1/runs/:id/cancel', async (req, reply) => {
    requireScope(req, 'runs:write');
    const run = await stores.runs.setStatus(req.ctx, req.params.id, 'cancelled');
    if (!run) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Run not found', 404));
    }
    await stores.audit.append(req.ctx, { action: 'run.cancelled', subject: run.id });
    return run;
  });

  /**
   * The question a model-risk reviewer actually asks: is this quarter's score
   * better, or did something change underneath?
   */
  app.post('/v1/runs/compare', async (req, reply) => {
    requireScope(req, 'runs:read');
    const { runA, runB } = compareRunsSchema.parse(req.body);
    const [a, b] = await Promise.all([
      stores.runs.get(req.ctx, runA),
      stores.runs.get(req.ctx, runB),
    ]);
    if (!a || !b) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'One or both runs not found', 404));
    }
    const { comparable } = await import('../evidence/index.js');
    const result = comparable(a.manifest as never, b.manifest as never);
    return {
      runA,
      runB,
      comparable: result.comparable,
      differences: result.differences,
      ...(result.comparable
        ? {}
        : { note: 'Scores from these runs cannot be compared directly.' }),
    };
  });

  // --------------------------------------------------------------- approvals

  app.get('/v1/approvals', async (req) => {
    requireScope(req, 'runs:read');
    const status = (req.query as { status?: string }).status as
      | 'pending'
      | undefined;
    return { items: await stores.approvals.list(req.ctx, status) };
  });

  app.post<{ Params: { id: string } }>('/v1/approvals/:id/decide', async (req, reply) => {
    requireScope(req, 'approvals:decide');
    const input = approvalDecisionSchema.parse(req.body);

    const existing = await stores.approvals.get(req.ctx, req.params.id);
    if (!existing) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Approval not found', 404));
    }
    if (existing.status !== 'pending') {
      return reply
        .status(409)
        .type('application/problem+json')
        .send(
          problem(
            'already-decided',
            'This approval has already been decided',
            409,
            `current status: ${existing.status}`,
          ),
        );
    }

    const statusMap = {
      approve: 'approved',
      reject: 'rejected',
      escalate: 'escalated',
    } as const;

    const updated = await stores.approvals.decide(req.ctx, req.params.id, {
      status: statusMap[input.decision],
      rationale: input.rationale,
      decidedBy: req.ctx.actor,
    });

    // Identity, decision and reason all go in the log. This is the Article 14
    // artifact -- an approval nobody can attribute evidences nothing.
    await stores.audit.append(req.ctx, {
      action: `approval.${statusMap[input.decision]}`,
      subject: existing.runId,
      payload: {
        approvalId: existing.id,
        gatedAction: existing.action,
        rationale: input.rationale,
      },
    });

    return updated;
  });

  // ---------------------------------------------------------------- evidence

  /**
   * Unauthenticated on purpose. Requiring a login to check a signature would
   * make the signature meaningless. Rotated keys stay published forever, or
   * every historical bundle silently becomes unverifiable on rotation day.
   */
  app.get('/v1/evidence/keys', async () => ({
    keys: [
      {
        keyId: signer.keyId,
        algorithm: 'ed25519' as const,
        publicKeyPem: signer.publicKeyPem(),
        validFrom: null,
        validUntil: null,
      },
    ],
  }));

  app.post('/v1/evidence/bundles', async (req, reply) => {
    requireScope(req, 'evidence:generate');
    const input = generateBundleSchema.parse(req.body);

    const run = await stores.runs.get(req.ctx, input.runId);
    if (!run) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Run not found', 404));
    }

    const entries = await stores.audit.entriesForSubject(req.ctx, input.runId);
    if (entries.length === 0) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send(
          problem(
            'no-audit-entries',
            'This run has no audit entries',
            422,
            'A bundle over an empty log would attest to nothing.',
          ),
        );
    }

    // One clock reading for the whole operation. resolveRetention and
    // createBundle both check the same 183-day floor, so calling new Date()
    // twice makes the period measure 182.99 days and the bundle is refused --
    // an off-by-milliseconds failure that looks like a policy error.
    const now = new Date();
    const retention = resolveRetention(input.retentionRules, now);
    const { root } = await stores.audit.root();
    const inclusionProofs = Object.fromEntries(
      await Promise.all(
        entries.map(async (e) => [e.seq, await stores.audit.inclusionProof(e.seq)] as const),
      ),
    );

    const bundleId = newId('bundle');
    let bundle: EvidenceBundle;
    try {
      bundle = await createBundle(
        {
          bundleId,
          tenantId: req.ctx.tenantId,
          runId: input.runId,
          manifest: run.manifest as never,
          entries,
          logRoot: root,
          logSize: (await stores.audit.root()).size,
          inclusionProofs,
          retention: {
            retainUntil: retention.retainUntil,
            policy: retention.governingRule,
            wormAnchored: false,
          },
          generatedAt: now,
        },
        signer,
      );
    } catch (e) {
      // createBundle refuses to sign over a broken chain. Surface that as a
      // 409 rather than a 500: it is a real state, not a server fault.
      return reply
        .status(409)
        .type('application/problem+json')
        .send(problem('unsignable', 'Bundle cannot be signed', 409, (e as Error).message));
    }

    await stores.bundles.create(req.ctx, {
      id: bundleId,
      runId: input.runId,
      bundle,
      retainUntil: retention.retainUntil,
      ...(retention.deleteBy ? { deleteBy: retention.deleteBy } : {}),
      createdAt: new Date(),
    });

    await stores.audit.append(req.ctx, {
      action: 'evidence.bundled',
      subject: input.runId,
      payload: { bundleId, entryCount: entries.length, retainUntil: retention.retainUntil.toISOString() },
    });

    return reply.status(201).send({ bundleId, bundle });
  });

  app.get<{ Params: { id: string } }>('/v1/evidence/bundles/:id', async (req, reply) => {
    requireScope(req, 'evidence:read');
    const record = await stores.bundles.get(req.ctx, req.params.id);
    if (!record) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Bundle not found', 404));
    }
    return record.bundle;
  });

  app.post<{ Params: { id: string } }>('/v1/evidence/bundles/:id/verify', async (req, reply) => {
    requireScope(req, 'evidence:read');
    const record = await stores.bundles.get(req.ctx, req.params.id);
    if (!record) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Bundle not found', 404));
    }
    return verifyBundle(record.bundle as EvidenceBundle, signer.publicKeyPem());
  });

  /**
   * A self-contained kit: the bundle, the key, and the formulas. Enough for a
   * reviewer to check the evidence on an air-gapped machine with no dependency
   * on this software. That is the difference between an audit trail and audit
   * evidence.
   */
  app.get<{ Params: { id: string } }>('/v1/evidence/bundles/:id/offline', async (req, reply) => {
    requireScope(req, 'evidence:read');
    const record = await stores.bundles.get(req.ctx, req.params.id);
    if (!record) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Bundle not found', 404));
    }
    return {
      bundle: record.bundle,
      publicKeyPem: signer.publicKeyPem(),
      keyId: signer.keyId,
      instructions: {
        signature: 'Ed25519 over the canonical JSON of `payload` (RFC 8785 key ordering).',
        merkle: [
          'RFC 6962 §2.1.',
          'MTH({}) = SHA-256()',
          'MTH({d(0)}) = SHA-256(0x00 || d(0))',
          'MTH(D[n]) = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n])), k the largest power of two < n',
          'Leaves are entry hashes as raw bytes, never hex text.',
        ],
        chain: 'entryHash = SHA-256(canonical(entry without entryHash)); previousHash links each entry to the last.',
      },
    };
  });

  // ---------------------------------------------------------------- identity

  /**
   * Who the current token says you are.
   *
   * The dashboard renders a profile from this rather than parsing the token
   * client-side, so the server stays the single source of truth about what a
   * caller may do. A UI that decides its own permissions will eventually
   * disagree with the thing enforcing them.
   */
  app.get('/v1/me', async (req) => ({
    actor: req.ctx.actor,
    tenantId: req.ctx.tenantId,
    scopes: req.ctx.scopes,
    authentication: 'bearer' as const,
    availableScopes: ALL_SCOPES.map((scope) => ({
      scope,
      description: SCOPE_DESCRIPTIONS[scope],
      consequential: CONSEQUENTIAL_SCOPES.includes(scope),
      held: req.ctx.scopes.includes(scope),
    })),
  }));

  // ---------------------------------------------------------------- api keys

  app.get('/v1/api-keys', async (req) => {
    requireScope(req, 'runs:read');
    // Read paths return metadata only. The secret is not stored, so it cannot
    // be returned here even by mistake.
    return { items: await apiKeys.list(req.ctx.tenantId) };
  });

  app.post('/v1/api-keys', async (req, reply) => {
    requireScope(req, 'runs:write');
    const input = createApiKeySchema.parse(req.body);

    const unknown = input.scopes.filter((s) => !ALL_SCOPES.includes(s as Scope));
    if (unknown.length > 0) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send(
          problem(
            'unknown-scope',
            'Unknown scope',
            422,
            `not a scope this control plane recognises: ${unknown.join(', ')}`,
            'scopes',
          ),
        );
    }

    try {
      const { key, secret } = await apiKeys.create(
        req.ctx.tenantId,
        req.ctx.actor,
        { name: input.name, description: input.description, scopes: input.scopes as Scope[] },
        req.ctx.scopes,
      );

      await stores.audit.append(req.ctx, {
        action: 'api-key.created',
        subject: key.id,
        // The secret is deliberately absent. An audit entry naming a live
        // credential would defeat not storing it.
        payload: { name: key.name, scopes: key.scopes, masked: key.masked },
      });

      // The one and only response that carries the plaintext.
      return reply.status(201).send({ key, secret });
    } catch (e) {
      if (e instanceof ApiKeyError) {
        return reply
          .status(e.status)
          .type('application/problem+json')
          .send(problem('api-key-rejected', 'API key not created', e.status, e.message));
      }
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/api-keys/:id', async (req, reply) => {
    requireScope(req, 'runs:read');
    const key = await apiKeys.get(req.ctx.tenantId, req.params.id);
    if (!key) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'API key not found', 404));
    }
    return key;
  });

  app.post<{ Params: { id: string } }>('/v1/api-keys/:id/revoke', async (req, reply) => {
    requireScope(req, 'runs:write');
    const existing = await apiKeys.get(req.ctx.tenantId, req.params.id);
    if (!existing) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'API key not found', 404));
    }
    if (existing.revokedAt) {
      return reply
        .status(409)
        .type('application/problem+json')
        .send(problem('already-revoked', 'This key is already revoked', 409));
    }

    const key = await apiKeys.revoke(req.ctx.tenantId, req.params.id, req.ctx.actor);
    await stores.audit.append(req.ctx, {
      action: 'api-key.revoked',
      subject: req.params.id,
      payload: { name: existing.name },
    });
    return key;
  });

  // ------------------------------------------------------------------- audit

  app.get('/v1/audit', async (req) => {
    requireScope(req, 'audit:read');
    const q = auditQuerySchema.parse(req.query);
    return stores.audit.query(req.ctx, q);
  });

  /** The value to publish or anchor. Give a counterparty today's root, and any
   *  future consistency proof lets them confirm nothing before it changed. */
  app.get('/v1/audit/root', async (req) => {
    requireScope(req, 'audit:read');
    return stores.audit.root();
  });

  app.get<{ Params: { seq: string } }>('/v1/audit/:seq', async (req, reply) => {
    requireScope(req, 'audit:read');
    const entry = await stores.audit.at(req.ctx, Number.parseInt(req.params.seq, 10));
    if (!entry) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Audit entry not found', 404));
    }
    return entry;
  });

  /**
   * The leaf is the entry *hash*, not the payload, so inclusion can be proved
   * without disclosing what the entry says. That is what makes selective
   * disclosure to an auditor possible.
   */
  app.get<{ Params: { seq: string } }>('/v1/audit/:seq/inclusion-proof', async (req, reply) => {
    requireScope(req, 'audit:read');
    const seq = Number.parseInt(req.params.seq, 10);
    const entry = await stores.audit.at(req.ctx, seq);
    if (!entry) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Audit entry not found', 404));
    }
    const [proof, { root }] = await Promise.all([
      stores.audit.inclusionProof(seq),
      stores.audit.root(),
    ]);
    return { proof, leaf: entry.entryHash, root };
  });

  app.get('/v1/audit/consistency-proof', async (req, reply) => {
    requireScope(req, 'audit:read');
    const { from } = consistencyQuerySchema.parse(req.query);
    const { root, size } = await stores.audit.root();
    if (from > size) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send(
          problem(
            'invalid-range',
            'Requested size exceeds the current log',
            422,
            `log has ${size} entries, asked for a proof from ${from}`,
            'from',
          ),
        );
    }
    return { proof: await stores.audit.consistencyProof(from), currentRoot: root, currentSize: size };
  });

  app.post('/v1/audit/verify', async (req) => {
    requireScope(req, 'audit:read');
    return stores.audit.verify();
  });

  return app;
}

/** Re-exported so a client can verify without importing the whole server. */
export { verifyInclusion, verifyConsistency, verifyBundle };
