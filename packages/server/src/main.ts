/**
 * Server entrypoint.
 *
 * The in-memory stores are the default so the control plane runs with no
 * dependencies at all -- useful for a demo, and wrong for anything else, so it
 * says so on startup rather than looking like a working deployment.
 */

import { buildApp } from './api/app.js';
import { DEV_TOKEN_EXAMPLE } from './api/docs.js';
import { InMemoryKeySource, Signer } from './evidence/index.js';
import { createInMemoryStores } from './store/index.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

const stores = createInMemoryStores();

// In production the private key belongs in an HSM or KMS, where this process
// can request a signature but never read the key. InMemoryKeySource satisfies
// the same interface, so that swap is configuration rather than a rewrite.
const signer = new Signer(InMemoryKeySource.generate(process.env.SIGNING_KEY_ID ?? 'dev-key-1'));

const app = await buildApp({ stores, signer, logger: true });

try {
  await app.listen({ port, host });
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  app.log.warn(
    'Running with in-memory stores and a process-local signing key. ' +
      'Evidence will not survive a restart and the key is reachable from this process. ' +
      'Configure Postgres and a KMS key source before this is used for anything real.',
  );

  // Printed rather than logged: this is for the person who just started it.
  console.log(`
  agent-eval control plane

    Browse    ${base}/docs        <- open this; click Authorize and paste the token below
    Discover  ${base}/v1
    Health    ${base}/v1/health
    Keys      ${base}/v1/evidence/keys   (no auth, on purpose)

  Development token
    ${DEV_TOKEN_EXAMPLE}

  A browser cannot send an Authorization header, so /docs is the way in.
`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
