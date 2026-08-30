/**
 * Provider and provider-credential routes.
 *
 * Separated from app.ts because the surface is self-contained and because
 * every route here touches a credential: keeping them in one file means the
 * places a secret can move are reviewable in one sitting.
 *
 * The invariant across all of them: a provider secret never travels to the
 * browser, and never enters the audit chain. Reads return metadata plus a
 * masked identifier, and decryption happens only on the path into an adapter.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CredentialError, type ProviderCredentialStore } from '../../auth/provider-credentials.js';
import { providerRegistry, resolveConfig } from '../../providers/registry.js';
import { ProviderError } from '../../providers/types.js';
import { createCredentialSchema, problem, testProviderSchema } from '../../schemas/index.js';
import type { AuditStore } from '../../store/index.js';

export interface ProviderRouteOptions {
  credentials: ProviderCredentialStore;
  audit: AuditStore;
  requireScope: (req: FastifyRequest, scope: string) => void;
}

export function registerProviderRoutes(app: FastifyInstance, options: ProviderRouteOptions): void {
  const { credentials, audit, requireScope } = options;

  /**
   * Registered providers and whether each is actually usable.
   *
   * Configured status is computed from stored credentials, never asserted, and
   * connection state is absent here on purpose — it requires a real request,
   * so it lives behind the test endpoint rather than being guessed at listing
   * time.
   */
  app.get('/v1/providers', async (req) => {
    requireScope(req, 'runs:read');
    const stored = await credentials.list(req.ctx.tenantId);
    return {
      encryptionConfigured: credentials.encryptionAvailable,
      items: providerRegistry.describe().map((p) => ({
        ...p,
        credentials: stored
          .filter((c) => c.providerId === p.id && !c.revokedAt)
          .map((c) => ({
            id: c.id,
            name: c.name,
            masked: c.masked,
            lastUsedAt: c.lastUsedAt,
          })),
      })),
    };
  });

  /** A real request against the provider. Never returns a canned status. */
  app.post('/v1/providers/test', async (req, reply) => {
    requireScope(req, 'runs:read');
    const { providerId, credentialId } = testProviderSchema.parse(req.body);

    if (!providerRegistry.has(providerId)) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Unknown provider', 404, providerId));
    }

    let config = resolveConfig(providerId);
    if (credentialId) {
      const revealed = await credentials.revealForProviderCall(req.ctx.tenantId, credentialId);
      if (!revealed) {
        return reply
          .status(404)
          .type('application/problem+json')
          .send(problem('not-found', 'Credential not found', 404));
      }
      config = { ...config, ...revealed };
    }

    const status = await providerRegistry.get(providerId).testConnection(config);

    await audit.append(req.ctx, {
      action: 'provider.tested',
      subject: providerId,
      // The outcome and which credential was used, never the credential.
      payload: { providerId, status: status.status, ...(credentialId ? { credentialId } : {}) },
    });

    return status;
  });

  /**
   * Model discovery, from the provider.
   *
   * There is no local list to fall back on, deliberately. A listing failure
   * says so and points at manual entry rather than substituting a stale array
   * that would be wrong within days of a provider release.
   */
  app.get('/v1/providers/:id/models', async (req, reply) => {
    requireScope(req, 'runs:read');
    const { id } = req.params as { id: string };
    const { credentialId } = req.query as { credentialId?: string };

    if (!providerRegistry.has(id)) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Unknown provider', 404));
    }

    const provider = providerRegistry.get(id);
    if (!provider.listModels) {
      return {
        items: [],
        listingSupported: false,
        note: 'This provider does not expose a model list. Enter a model id directly.',
      };
    }

    let config = resolveConfig(id);
    if (credentialId) {
      const revealed = await credentials.revealForProviderCall(req.ctx.tenantId, credentialId);
      if (revealed) config = { ...config, ...revealed };
    }

    try {
      const items = await provider.listModels(config);
      // Timestamped so a cached list can never be mistaken for live data.
      return { items, listingSupported: true, fetchedAt: new Date().toISOString() };
    } catch (e) {
      const detail =
        e instanceof ProviderError
          ? `${e.category}: ${e.message}. You can still enter a model id manually.`
          : (e as Error).message;
      return reply
        .status(502)
        .type('application/problem+json')
        .send(problem('provider-error', 'Unable to list models', 502, detail));
    }
  });

  // ----------------------------------------------------- provider credentials

  app.get('/v1/provider-credentials', async (req) => {
    requireScope(req, 'runs:read');
    // Metadata only. The secret is encrypted and has no read path at all.
    return { items: await credentials.list(req.ctx.tenantId) };
  });

  app.post('/v1/provider-credentials', async (req, reply) => {
    requireScope(req, 'runs:write');
    const input = createCredentialSchema.parse(req.body);

    if (!providerRegistry.has(input.providerId)) {
      return reply
        .status(422)
        .type('application/problem+json')
        .send(problem('unknown-provider', 'Unknown provider', 422, input.providerId, 'providerId'));
    }

    try {
      const credential = await credentials.create(req.ctx.tenantId, req.ctx.actor, input);

      await audit.append(req.ctx, {
        action: 'provider-credential.created',
        subject: credential.id,
        // Masked identifier only; the secret never enters the chain.
        payload: {
          providerId: credential.providerId,
          name: credential.name,
          masked: credential.masked,
        },
      });

      return reply.status(201).send(credential);
    } catch (e) {
      if (e instanceof CredentialError) {
        return reply
          .status(e.status)
          .type('application/problem+json')
          .send(problem('credential-rejected', 'Credential not stored', e.status, e.message));
      }
      throw e;
    }
  });

  app.post('/v1/provider-credentials/:id/revoke', async (req, reply) => {
    requireScope(req, 'runs:write');
    const { id } = req.params as { id: string };

    const revoked = await credentials.revoke(req.ctx.tenantId, id, req.ctx.actor);
    if (!revoked) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Credential not found', 404));
    }

    await audit.append(req.ctx, {
      action: 'provider-credential.revoked',
      subject: id,
      payload: { providerId: revoked.providerId, name: revoked.name },
    });

    return revoked;
  });
}
