/**
 * API tests via `app.inject()` — no socket, no port, no fixtures server.
 *
 * The cases that carry weight are the refusals. An API for a compliance
 * product is defined more by what it declines to record than by what it
 * accepts: a run that cannot say what it ran, an approval with no reason, a
 * bundle over a broken chain.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../api/app.js';
import { InMemoryKeySource, Signer, verifyBundle, verifyInclusion } from '../../evidence/index.js';
import { createInMemoryStores, type InMemoryAuditStore, type Stores } from '../../store/index.js';

const DIGEST = 'sha256:' + 'a'.repeat(64);

const ADMIN =
  'Bearer t1:reviewer@example.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read';
const OTHER_TENANT =
  'Bearer t2:someone@other.test:runs:read,runs:write,evidence:read,evidence:generate,audit:read';
const READ_ONLY = 'Bearer t1:viewer@example.test:runs:read';

function validRun(over: Record<string, unknown> = {}) {
  return {
    environmentId: 'env_1',
    environmentDigest: DIGEST,
    taskSetId: 'swe-bench-verified',
    taskSetVersion: '2026.01',
    split: 'held-out',
    verifierId: 'pytest',
    verifierVersion: '3.1.0',
    model: { identifier: 'anthropic/claude-sonnet-4-5', sampling: { temperature: 0 } },
    seed: 42,
    isolationBackend: 'firecracker',
    toolchain: { 'agent-eval': '1.0.0' },
    retentionRules: ['eu-ai-act-art-19'],
    ...over,
  };
}

let app: FastifyInstance;
let stores: Stores & { audit: InMemoryAuditStore };
let signer: Signer;

beforeEach(async () => {
  stores = createInMemoryStores();
  signer = new Signer(InMemoryKeySource.generate('test-key'));
  app = await buildApp({ stores, signer, docs: false });
  await app.ready();
});

describe('auth and tenancy', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/runs' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('sends WWW-Authenticate on a 401', async () => {
    // RFC 9110 §11.6.1 requires it. Without the header a client cannot tell
    // how to authenticate, and conforming HTTP libraries will not retry.
    const res = await app.inject({ method: 'GET', url: '/v1/runs' });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="agent-eval"');
  });

  it('tells an unauthenticated caller where to look', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/runs' });
    expect(res.json().detail).toMatch(/GET \/v1/);
  });

  it('distinguishes a missing header from an unparseable one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/runs',
      headers: { authorization: 'Bearer nonsense' },
    });
    expect(res.json().detail).toMatch(/could not be parsed/);
  });

  it('serves the browsable docs without a token', async () => {
    // A browser cannot set an Authorization header, so requiring one on the
    // UI that exists to supply that header would be circular.
    const docsApp = await buildApp({ stores, signer, docs: true });
    await docsApp.ready();
    const res = await docsApp.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('publishes an OpenAPI document with a bearer scheme', async () => {
    const docsApp = await buildApp({ stores, signer, docs: true });
    await docsApp.ready();
    const res = await docsApp.inject({ method: 'GET', url: '/docs/json' });
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    // The token format has to be discoverable; it is otherwise unguessable.
    expect(spec.info.description).toMatch(/tenantId/);
  });

  it('still protects endpoints behind the docs UI', async () => {
    const docsApp = await buildApp({ stores, signer, docs: true });
    await docsApp.ready();
    const res = await docsApp.inject({ method: 'GET', url: '/v1/runs' });
    expect(res.statusCode).toBe(401);
  });

  it('serves a discovery root without auth', async () => {
    // The first thing anyone does with a new API is open it in a browser. A
    // wall of 401s with no way to discover the token format is a dead end.
    const res = await app.inject({ method: 'GET', url: '/v1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authentication.development).toMatch(/tenantId/);
    expect(res.json().authentication.scopes).toContain('evidence:generate');
  });

  it('enforces scopes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: READ_ONLY },
      payload: validRun(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/runs:write/);
  });

  it('does not leak across tenants', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun(),
    });
    const { runId } = created.json();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/runs/${runId}`,
      headers: { authorization: OTHER_TENANT },
    });
    // 404, not 403: another tenant's run does not exist as far as this caller
    // is concerned. A 403 would confirm the id is real.
    expect(res.statusCode).toBe(404);
  });

  it('serves public keys without auth', async () => {
    // An auditor must be able to verify a signature without an account here.
    const res = await app.inject({ method: 'GET', url: '/v1/evidence/keys' });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys[0].algorithm).toBe('ed25519');
    expect(res.json().keys[0].publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });
});

describe('starting a run', () => {
  it('accepts a reproducible run with 202', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun(),
    });
    // 202: a run is a long-lived session, not a resource that exists on ask.
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('queued');
  });

  it('rejects an image referenced by tag', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun({ environmentDigest: 'env:latest' }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().field).toBe('environmentDigest');
    expect(res.json().detail).toMatch(/pinned/);
  });

  it('rejects a run with no toolchain recorded', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun({ toolchain: {} }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/platform version/);
  });

  it('rejects a run with no retention basis', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun({ retentionRules: [] }),
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an unknown retention rule by name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun({ retentionRules: ['invented-regime'] }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/Known rules/);
  });

  it('records run.started in the audit log', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun(),
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: ADMIN },
    });
    expect(audit.json().items[0].action).toBe('run.started');
  });

  it('records nothing when the run is rejected', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: { authorization: ADMIN },
      payload: validRun({ environmentDigest: 'bad' }),
    });
    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: ADMIN },
    });
    expect(audit.json().items).toHaveLength(0);
  });
});

describe('comparing runs', () => {
  it('calls two identical configurations comparable', async () => {
    const a = (
      await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() })
    ).json();
    const b = (
      await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/compare',
      headers: { authorization: ADMIN },
      payload: { runA: a.runId, runB: b.runId },
    });
    expect(res.json().comparable).toBe(true);
  });

  it('flags a changed isolation backend', async () => {
    const a = (
      await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() })
    ).json();
    const b = (
      await app.inject({
        method: 'POST',
        url: '/v1/runs',
        headers: { authorization: ADMIN },
        payload: validRun({ isolationBackend: 'gvisor' }),
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs/compare',
      headers: { authorization: ADMIN },
      payload: { runA: a.runId, runB: b.runId },
    });
    expect(res.json().comparable).toBe(false);
    expect(res.json().differences).toContain('isolationBackend');
    expect(res.json().note).toMatch(/cannot be compared/);
  });
});

describe('approvals', () => {
  async function pendingApproval(runId: string) {
    return stores.approvals.create(
      { tenantId: 't1', actor: 'system', scopes: [] },
      {
        id: 'apr_1',
        runId,
        action: 'write:production',
        status: 'pending',
        deadline: new Date(Date.now() + 3_600_000),
        onTimeout: 'deny',
        trajectoryContext: { trialId: 'trial_1', throughStep: 47 },
        createdAt: new Date(),
      },
    );
  }

  it('requires a rationale even on approve', async () => {
    // An approval with no recorded reason evidences a click, not oversight.
    await pendingApproval('run_1');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/apr_1/decide',
      headers: { authorization: ADMIN },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/rationale/i);
  });

  it('records identity, decision and reason', async () => {
    await pendingApproval('run_1');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/apr_1/decide',
      headers: { authorization: ADMIN },
      payload: { decision: 'reject', rationale: 'Production writes are out of scope for this eval.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decidedBy).toBe('reviewer@example.test');

    const audit = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: ADMIN },
    });
    const entry = audit.json().items.find((e: { action: string }) => e.action === 'approval.rejected');
    expect(entry.payload.rationale).toMatch(/out of scope/);
  });

  it('refuses to decide the same approval twice', async () => {
    await pendingApproval('run_1');
    const decide = () =>
      app.inject({
        method: 'POST',
        url: '/v1/approvals/apr_1/decide',
        headers: { authorization: ADMIN },
        payload: { decision: 'approve', rationale: 'Reviewed and within scope.' },
      });
    expect((await decide()).statusCode).toBe(200);
    expect((await decide()).statusCode).toBe(409);
  });

  it('states what happens if nobody acts', async () => {
    await pendingApproval('run_1');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers: { authorization: ADMIN },
    });
    // A silent timeout default is a governance hazard.
    expect(res.json().items[0].onTimeout).toBe('deny');
  });
});

describe('evidence', () => {
  async function runWithHistory() {
    const { runId } = (
      await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() })
    ).json();
    const ctx = { tenantId: 't1', actor: 'agent', scopes: [] };
    await stores.audit.append(ctx, { action: 'tool.called', subject: runId, payload: { tool: 'bash' } });
    await stores.audit.append(ctx, { action: 'run.completed', subject: runId });
    return runId;
  }

  it('produces a bundle that verifies with only the public key', async () => {
    const runId = await runWithHistory();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/evidence/bundles',
      headers: { authorization: ADMIN },
      payload: { runId, retentionRules: ['eu-ai-act-art-19'] },
    });
    expect(res.statusCode).toBe(201);

    const keys = (await app.inject({ method: 'GET', url: '/v1/evidence/keys' })).json();
    const result = verifyBundle(res.json().bundle, keys.keys[0].publicKeyPem);
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('resolves overlapping regimes to the longest floor', async () => {
    const runId = await runWithHistory();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/evidence/bundles',
      headers: { authorization: ADMIN },
      payload: { runId, retentionRules: ['eu-ai-act-art-19', 'hipaa-164-316'] },
    });
    expect(res.json().bundle.payload.retention.policy).toBe('hipaa-164-316');
  });

  it('refuses a bundle over a run with no history', async () => {
    const { runId } = (
      await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() })
    ).json();
    // Cancel removes nothing, but the point is a run whose only entry is its own
    // start still bundles; a run with no entries at all must not.
    const empty = createInMemoryStores();
    const bare = await buildApp({ stores: empty, signer, docs: false });
    await bare.ready();
    const res = await bare.inject({
      method: 'POST',
      url: '/v1/evidence/bundles',
      headers: { authorization: ADMIN },
      payload: { runId, retentionRules: ['eu-ai-act-art-19'] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('ships an offline kit with the formulas', async () => {
    const runId = await runWithHistory();
    const { bundleId } = (
      await app.inject({
        method: 'POST',
        url: '/v1/evidence/bundles',
        headers: { authorization: ADMIN },
        payload: { runId, retentionRules: ['eu-ai-act-art-19'] },
      })
    ).json();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/evidence/bundles/${bundleId}/offline`,
      headers: { authorization: ADMIN },
    });
    const kit = res.json();
    expect(kit.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
    expect(kit.instructions.merkle.join(' ')).toMatch(/largest power of two/);
    expect(kit.instructions.merkle.join(' ')).toMatch(/never hex text/);
  });
});

describe('audit and proofs', () => {
  it('proves inclusion without disclosing the payload', async () => {
    await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/0/inclusion-proof',
      headers: { authorization: ADMIN },
    });
    const { proof, leaf, root } = res.json();

    // The leaf is the entry hash. A verifier confirms membership with no
    // access to what the entry says.
    const result = verifyInclusion(proof, Buffer.from(leaf, 'hex'), root);
    expect(result.valid).toBe(true);
  });

  it('reports a clean chain', async () => {
    await app.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: ADMIN }, payload: validRun() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/verify',
      headers: { authorization: ADMIN },
    });
    expect(res.json().valid).toBe(true);
  });

  it('refuses a consistency proof from beyond the log', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/consistency-proof?from=999',
      headers: { authorization: ADMIN },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().field).toBe('from');
  });

  it('has no route that deletes an audit entry', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/audit/0',
      headers: { authorization: ADMIN },
    });
    // An API that can delete an entry is not an append-only log, whatever the
    // storage layer does underneath.
    expect(res.statusCode).toBe(404);
  });
});
