/**
 * OpenAPI document and browsable UI.
 *
 * The problem this solves is narrower than it looks. A browser cannot set an
 * `Authorization` header, so opening any protected endpoint directly returns
 * 401 no matter how good the error message is. Improving the message does not
 * help, because the person reading it has no way to act on it from the address
 * bar.
 *
 * Swagger UI is the conventional answer: it holds the token in the page and
 * attaches the header to requests it makes on your behalf. `/docs` is
 * therefore the browsable entry point, and `GET /v1` stays as the
 * machine-readable one for anything that is not a browser.
 *
 * The spec is also worth having on its own. An OpenAPI document is what a
 * procurement reviewer asks for when they want to know what the API exposes
 * without reading the source, and it generates clients in whatever language
 * the buyer's integration team uses.
 */

import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export const DEV_TOKEN_EXAMPLE =
  'acme:you@example.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read';

export async function registerDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'agent-eval control plane',
        version: '1.0.0',
        description:
          'Audit-grade evaluation control plane for agentic AI.\n\n' +
          '**Authorize first.** Click the padlock and paste a development token:\n\n' +
          '```\n' +
          DEV_TOKEN_EXAMPLE +
          '\n```\n\n' +
          'Format is `<tenantId>:<actor>:<comma-separated scopes>`. Anything before ' +
          'the first colon is the tenant, so two different tenant strings give you ' +
          'two isolated worlds to test isolation against.\n\n' +
          '`GET /v1/evidence/keys` is deliberately unauthenticated: an auditor must ' +
          'be able to verify a signature without an account on the system that ' +
          'produced it.',
      },
      servers: [{ url: '/', description: 'This server' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
              'Production: an OIDC access token. Development: ' +
              '`<tenantId>:<actor>:<comma-separated scopes>`.',
          },
        },
      },
      // Applied by default; public routes opt out with `security: []`.
      security: [{ bearerAuth: [] }],
      tags: [
        { name: 'discovery', description: 'Unauthenticated entry points' },
        { name: 'runs', description: 'Start, inspect and compare evaluation runs' },
        { name: 'approvals', description: 'Human oversight — the EU AI Act Art. 14 surface' },
        { name: 'evidence', description: 'Signed, article-mapped evidence bundles' },
        { name: 'audit', description: 'Append-only log, inclusion and consistency proofs' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      // Keeps the token across reloads so exploring does not mean re-pasting
      // it after every change.
      persistAuthorization: true,
    },
    staticCSP: true,
  });
}
