/**
 * Server entrypoint: control plane plus the run worker.
 *
 * The worker runs in-process because there is one node and an in-memory store.
 * Moving it to a separate process is a deployment change, not a rewrite: it
 * talks to the stores through the same interfaces the API does.
 *
 * Execution defaults to unavailable. A control plane that accepts runs nobody
 * can execute leaves them in `queued` looking like progress, so if nothing can
 * run, /v1/ready says 503 and says why.
 */

import { buildApp } from './api/app.js';
import { detectCapabilities, toEnvironmentRecord } from './system/capabilities.js';
import { SecretBox } from './auth/encryption.js';
import { ProviderCredentialStore } from './auth/provider-credentials.js';
import { DEV_TOKEN_EXAMPLE } from './api/docs.js';
import { InMemoryKeySource, Signer } from './evidence/index.js';
import { createInMemoryStores } from './store/index.js';
import { LocalProcessExecutor, selectExecutor } from './worker/executor.js';
import { RunWorker } from './worker/worker.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';

// Unisolated execution is opt-in. It provides no guest kernel, no egress
// control and no credential brokering, so it is never a default.
const localExecEnabled = process.env.AGENT_EVAL_LOCAL_EXEC === '1';
const modelExecEnabled = process.env.AGENT_EVAL_MODEL_EXEC === '1';
const localOptions = { enabled: localExecEnabled };
// Ready when either execution path is open.
const executionUnavailable =
  localExecEnabled || modelExecEnabled
    ? null
    : new LocalProcessExecutor(localOptions).unavailableReason();

const stores = createInMemoryStores();

// One store, shared by the API that writes credentials and the worker that
// spends them. Two instances would mean a credential saved through the
// dashboard was invisible to every run.
const credentials = new ProviderCredentialStore(SecretBox.fromEnv());
const signer = new Signer(InMemoryKeySource.generate(process.env.SIGNING_KEY_ID ?? 'dev-key-1'));

const worker = new RunWorker({
  runs: stores.runs,
  audit: stores.audit,
  selectExecutor: (backend) =>
    selectExecutor(backend, localOptions, modelExecEnabled, (tenantId, credentialId) =>
      credentials.revealForProviderCall(tenantId, credentialId),
    ),
  pollIntervalMs: Number(process.env.WORKER_POLL_MS ?? 500),
  // Probed once per claimed run. A failure here must not fail the run: the
  // evidence then records no environment, which is honest, rather than a
  // guess about the host.
  captureEnvironment: async () => {
    try {
      return toEnvironmentRecord(await detectCapabilities());
    } catch {
      return undefined;
    }
  },
  log: (level, message, fields) => {
    // Structured, correlated by runId. Never carries secrets.
    console.log(JSON.stringify({ level, message, ...fields, at: new Date().toISOString() }));
  },
});

const app = await buildApp({
  stores,
  signer,
  worker,
  credentials,
  executionUnavailable,
  logger: false,
});

try {
  await app.listen({ port, host });
  worker.start();

  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  console.log(`
  agent-eval control plane

    Dashboard  http://127.0.0.1:5173
    Browse     ${base}/docs
    Readiness  ${base}/v1/ready

  Development token
    ${DEV_TOKEN_EXAMPLE}

  Worker     running (${worker.status().workerId})
  Execution  ${
    executionUnavailable
      ? 'UNAVAILABLE - set AGENT_EVAL_LOCAL_EXEC=1 to enable unisolated local execution'
      : 'local-process (NO isolation boundary)'
  }
  Storage    in-memory - evidence does not survive a restart
`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    worker.stop();
    void app.close().then(() => process.exit(0));
  });
}
