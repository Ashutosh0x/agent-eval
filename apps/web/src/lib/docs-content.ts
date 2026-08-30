/**
 * Documentation content.
 *
 * Kept as structured data rather than markdown strings so that search can
 * index it properly: a query needs to match against a section's prose, its
 * code, and its table cells, and return the specific section rather than the
 * whole page. Rendering markdown would mean either shipping a parser or
 * searching raw syntax.
 *
 * Everything here is checked against the implementation. Where the platform
 * does not do something, this file says so — the "Not implemented" section
 * exists because documentation that quietly omits gaps is how a reader forms a
 * wrong model of what they are running.
 */

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'code'; lang: string; code: string; caption?: string }
  | { kind: 'list'; items: string[]; ordered?: boolean }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'note'; tone: 'info' | 'warn' | 'danger'; title: string; text: string }
  | { kind: 'h3'; text: string };

export interface DocSection {
  id: string;
  title: string;
  /** One line, shown in search results and under the heading. */
  summary: string;
  blocks: Block[];
}

export interface DocGroup {
  id: string;
  title: string;
  sections: DocSection[];
}

const DEV_TOKEN =
  'acme:you@example.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read';

export const DOC_GROUPS: DocGroup[] = [
  {
    id: 'start',
    title: 'Getting started',
    sections: [
      {
        id: 'what-it-is',
        title: 'What agent-eval is',
        summary:
          'A self-hosted control plane that turns agent evaluation runs into evidence an auditor can check without trusting you.',
        blocks: [
          {
            kind: 'p',
            text: 'Most evaluation tooling answers one question: what score did the model get? agent-eval answers a harder one that regulated deployments actually face — can you prove, months later, what you ran, on what, with which model, and that the record has not been edited since?',
          },
          {
            kind: 'p',
            text: 'The difference shows up in the design. Every run carries a manifest naming the environment digest, task set version, verifier version, model, seed and toolchain. Every state change is appended to a hash-chained log committed to an RFC 6962 Merkle tree. An evidence bundle over a run is signed with Ed25519 and can be verified by someone with only the bundle and a public key — no access to this system, no trust in it.',
          },
          {
            kind: 'p',
            text: 'It is self-hosted because the data is the point. Evaluation traces contain prompts, model outputs and often customer data; sending them to a vendor to prove compliance is a strange way to comply.',
          },
          {
            kind: 'note',
            tone: 'info',
            title: 'The design rule everything follows',
            text: 'The interface never claims more than the system did. A provider that has not been tested has no connection status rather than a hopeful one. A capability the provider does not document is reported as unknown, not assumed. A run that cannot execute fails loudly instead of running somewhere less isolated.',
          },
        ],
      },
      {
        id: 'quick-start',
        title: 'Quick start',
        summary: 'Get a control plane, a dashboard and a real evaluation run in about five minutes.',
        blocks: [
          { kind: 'h3', text: '1. Install' },
          {
            kind: 'code',
            lang: 'bash',
            code: 'git clone https://github.com/Ashutosh0x/agent-eval.git\ncd agent-eval\npnpm install',
          },
          { kind: 'h3', text: '2. Generate an encryption key' },
          {
            kind: 'p',
            text: 'Provider credentials are encrypted at rest. There is no default key, because a default would be identical in every deployment and published in the repository.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'export AGENT_EVAL_ENCRYPTION_KEY=$(node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))")',
          },
          { kind: 'h3', text: '3. Start the control plane' },
          {
            kind: 'code',
            lang: 'bash',
            code: 'cd packages/server\nAGENT_EVAL_MODEL_EXEC=1 npx tsx src/main.ts',
            caption: 'AGENT_EVAL_MODEL_EXEC=1 allows runs that call a model provider. Without it the platform accepts runs and refuses to execute them, which it says on /v1/ready.',
          },
          { kind: 'h3', text: '4. Start the dashboard' },
          {
            kind: 'code',
            lang: 'bash',
            code: 'cd apps/web\npnpm dev',
            caption: 'Vite serves on http://localhost:5173 and proxies /v1 to the control plane on 8080.',
          },
          { kind: 'h3', text: '5. Sign in' },
          {
            kind: 'p',
            text: 'The dashboard asks for a token. In development that is a plain string of the form tenantId:actor:scopes — the stand-in for an OIDC access token, with the same shape of claims.',
          },
          { kind: 'code', lang: 'text', code: DEV_TOKEN },
          { kind: 'h3', text: '6. Run something real' },
          {
            kind: 'p',
            text: 'The fastest provider to reach is a local Ollama, because it needs no credential. Install Ollama, pull a small model, then use Runs → Start a run with provider ollama and model id gemma3:4b.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'ollama pull gemma3:4b',
          },
        ],
      },
      {
        id: 'first-run',
        title: 'Your first run, end to end',
        summary: 'From starting a run to verifying its evidence bundle offline.',
        blocks: [
          {
            kind: 'list',
            ordered: true,
            items: [
              'Settings → Providers → Ollama → Add credential. Ollama needs no API key; set the base URL to http://127.0.0.1:11434.',
              'Press Test connection. This makes a real HTTP request. If Ollama is not running you get "unavailable" with the reason, not a green light.',
              'Press Discover models. The list comes from Ollama, not from this application.',
              'Runs → Start a run. Fill the manifest fields, choose provider ollama, type the model id, pick the credential, leave the backend as model.',
              'The run appears as queued. A worker claims it within a second, the status moves to running, then completed or failed.',
              'Open the run. Every audit entry is listed in order with its sequence number — these are the real chained entries, not a rendering of them.',
              'Generate an evidence bundle. It is signed immediately.',
              'Download it and verify it locally with the CLI. That last step is the one that matters: it uses no network and none of this system.',
            ],
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval evidence download bundle_abc123 --out bundle.json\nagent-eval evidence verify bundle.json',
          },
          {
            kind: 'code',
            lang: 'text',
            code: '  PASS  signature\n  PASS  entryDigests\n  PASS  ordering\n  PASS  inclusion\n  PASS  manifest\n\n  BUNDLE VALID',
          },
          {
            kind: 'p',
            text: 'Change one character anywhere in that file and re-run the command. The signature fails and the altered entry is named by sequence number.',
          },
        ],
      },
    ],
  },

  {
    id: 'config',
    title: 'Configuration',
    sections: [
      {
        id: 'environment',
        title: 'Environment variables',
        summary: 'Every variable the server reads, what it does, and what happens when it is absent.',
        blocks: [
          {
            kind: 'table',
            headers: ['Variable', 'Default', 'Effect'],
            rows: [
              ['AGENT_EVAL_ENCRYPTION_KEY', 'none', '64 hex characters. Required to store provider credentials. Absent, the server refuses to store them rather than writing plaintext.'],
              ['AGENT_EVAL_MODEL_EXEC', 'unset', '1 allows runs whose backend is model to call a provider.'],
              ['AGENT_EVAL_LOCAL_EXEC', 'unset', '1 allows local-process execution, which has NO isolation boundary.'],
              ['PORT', '8080', 'Control plane port.'],
              ['HOST', '127.0.0.1', 'Bind address. Change deliberately; this service holds credentials.'],
              ['WORKER_POLL_MS', '500', 'How often the worker looks for a queued run.'],
              ['SIGNING_KEY_ID', 'dev-key-1', 'Key id recorded in every signature.'],
            ],
          },
          { kind: 'h3', text: 'Provider fallbacks' },
          {
            kind: 'p',
            text: 'When a run does not name a stored credential, the provider falls back to these. Storing a credential through the dashboard is preferred: it is encrypted, tenant-scoped, revocable, and attributable.',
          },
          {
            kind: 'table',
            headers: ['Provider', 'Variable'],
            rows: [
              ['openai', 'OPENAI_API_KEY'],
              ['anthropic', 'ANTHROPIC_API_KEY'],
              ['xai', 'XAI_API_KEY'],
              ['google', 'GOOGLE_API_KEY'],
              ['deepseek', 'DEEPSEEK_API_KEY'],
              ['mistral', 'MISTRAL_API_KEY'],
              ['minimax', 'MINIMAX_API_KEY'],
              ['openai-compatible', 'OPENAI_COMPATIBLE_API_KEY + OPENAI_COMPATIBLE_BASE_URL'],
              ['ollama', 'OLLAMA_BASE_URL (no key)'],
            ],
          },
        ],
      },
      {
        id: 'encryption',
        title: 'Credential encryption',
        summary: 'AES-256-GCM with tenant-bound associated data, and why hashing would be the wrong tool.',
        blocks: [
          {
            kind: 'p',
            text: 'An agent-eval API key and a provider credential are protected differently, and the reason decides the mechanism. An API key only has to be recognised, so the server stores a one-way hash and can never recover it. A provider credential has to be replayed — the server must send your real OpenAI key to OpenAI — so it must be recoverable, which means encryption rather than hashing.',
          },
          {
            kind: 'p',
            text: 'AES-256-GCM authenticates as well as encrypts. Without the tag, ciphertext in a compromised database could be altered undetectably, and a credential that decrypts to attacker-chosen bytes is worse than one that merely leaks: it redirects requests.',
          },
          {
            kind: 'p',
            text: 'Each ciphertext is bound to its tenant and record through GCM associated data. A row copied to another tenant will not decrypt, so a database-level attacker cannot hand one tenant another tenant’s credential without breaking the cryptography.',
          },
          {
            kind: 'code',
            lang: 'text',
            code: 'aad = agent-eval:provider-credential:${tenantId}:${credentialId}',
          },
          {
            kind: 'note',
            tone: 'danger',
            title: 'Losing the key',
            text: 'Stored credentials become undecryptable and must be re-entered. There is no recovery path, which is what "encrypted at rest" means.',
          },
        ],
      },
      {
        id: 'retention',
        title: 'Retention rules',
        summary: 'The regimes the platform can resolve, and how conflicting ones combine.',
        blocks: [
          {
            kind: 'p',
            text: 'Every run declares at least one retention basis. When several apply, the longest floor wins — a bundle covered by both a six-month and a six-year rule is kept six years.',
          },
          {
            kind: 'table',
            headers: ['id', 'Basis', 'Minimum'],
            rows: [
              ['eu-ai-act-art-19', 'EU AI Act Art. 19 — automatically generated logs', '183 days'],
              ['eu-ai-act-annex-iv', 'EU AI Act Art. 11 + Annex IV — technical documentation', '3653 days'],
              ['hipaa-164-316', 'HIPAA §164.316(b)(2)(i)', '2191 days'],
              ['sox-17a-4', 'SEC 17a-4 — records preservation', '2191 days'],
              ['gdpr-storage-limitation', 'GDPR Art. 5(1)(e) — no longer than necessary', '0 days'],
            ],
          },
          {
            kind: 'note',
            tone: 'warn',
            title: 'Not legal advice',
            text: 'These are the durations the platform enforces, not an opinion about what applies to you. The list is deliberately not exhaustive; an operator adds the regimes that govern them.',
          },
        ],
      },
    ],
  },

  {
    id: 'auth',
    title: 'Authentication',
    sections: [
      {
        id: 'tokens',
        title: 'Tokens and scopes',
        summary: 'How callers authenticate, and what each of the seven scopes permits.',
        blocks: [
          {
            kind: 'p',
            text: 'Two credential forms are accepted on the Authorization header. An API key begins ae_live_ and is resolved against the key store; anything else is parsed as a development token of the form tenantId:actor:scopes. In production the second is replaced by an OIDC access token — the claims it carries are the same three.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'curl -H "Authorization: Bearer ae_live_…" http://127.0.0.1:8080/v1/runs',
          },
          {
            kind: 'table',
            headers: ['Scope', 'Permits'],
            rows: [
              ['runs:read', 'View runs, manifests and comparisons.'],
              ['runs:write', 'Start and cancel runs; store credentials.'],
              ['evidence:read', 'Read and verify evidence bundles.'],
              ['evidence:generate', 'Generate and sign new bundles.'],
              ['approvals:decide', 'Approve, reject or escalate gated actions.'],
              ['audit:read', 'Query the audit log and request proofs.'],
              ['splits:held-out', 'Read held-out task splits.'],
            ],
          },
          {
            kind: 'note',
            tone: 'info',
            title: 'A key cannot exceed its creator',
            text: 'You cannot mint a key with scopes you do not hold. Without that rule, any actor with one scope could issue themselves an all-scope credential and the scope system would be decorative.',
          },
        ],
      },
      {
        id: 'api-keys',
        title: 'API keys',
        summary: 'Created once, shown once, never recoverable — and why SHA-256 is correct here.',
        blocks: [
          {
            kind: 'p',
            text: 'A secret is 256 bits from a CSPRNG, so there is nothing to brute-force offline. SHA-256 is the right store, not scrypt or bcrypt: those exist to slow attacks on low-entropy human-chosen secrets and would buy nothing here while making every request slower. This is what Stripe and GitHub do with their tokens.',
          },
          {
            kind: 'p',
            text: 'The plaintext exists at exactly one moment — the response to the creation call. It is never written to the store, never logged, and never returned by any read path. Lose it and you rotate, which is the entire point of a credential the issuer cannot recover.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval keys create --name "CI runner" --scopes runs:read,runs:write --expires-in-days 90',
          },
          {
            kind: 'p',
            text: 'Keys may expire. An expired key is refused with a reason distinct from an unknown one, because an operator debugging a broken integration needs to know which happened. Revocation takes effect on the next request.',
          },
        ],
      },
    ],
  },

  {
    id: 'providers',
    title: 'Providers and models',
    sections: [
      {
        id: 'provider-list',
        title: 'Supported providers',
        summary: 'Nine providers across four wire formats, with no model list anywhere.',
        blocks: [
          {
            kind: 'table',
            headers: ['id', 'Provider', 'Credential', 'Listing', 'Wire format'],
            rows: [
              ['openai', 'OpenAI', 'required', 'supported', 'OpenAI'],
              ['anthropic', 'Anthropic', 'required', 'supported', 'Anthropic Messages'],
              ['xai', 'xAI', 'required', 'supported', 'OpenAI-compatible'],
              ['google', 'Google Gemini', 'required', 'supported', 'Gemini generateContent'],
              ['deepseek', 'DeepSeek', 'required', 'supported', 'OpenAI-compatible'],
              ['mistral', 'Mistral', 'required', 'supported', 'OpenAI-compatible'],
              ['minimax', 'MiniMax', 'required', 'unknown', 'OpenAI-compatible'],
              ['ollama', 'Ollama', 'none', 'supported', 'Ollama'],
              ['openai-compatible', 'Any compatible endpoint', 'required', 'unknown', 'OpenAI-compatible'],
            ],
          },
          {
            kind: 'p',
            text: 'Six share one transport because they genuinely speak the same protocol. Only Anthropic, Google and Ollama differ enough to need their own adapter. Adding another OpenAI-compatible provider is a configuration object, not an implementation.',
          },
          {
            kind: 'note',
            tone: 'info',
            title: 'unknown is not no',
            text: 'A listing value of unknown means nobody has established whether that provider exposes an enumeration API. Discovery attempts it and reports what comes back, because a failed probe is itself information.',
          },
        ],
      },
      {
        id: 'no-model-list',
        title: 'Why there is no model list',
        summary: 'Models are discovered from the provider, so a model released today is usable today.',
        blocks: [
          {
            kind: 'p',
            text: 'No model list is compiled into the server, the SDK, the CLI or the dashboard. A hardcoded list is wrong within days of a provider release, and wrong silently: the model exists, the platform refuses it, and the refusal looks like a provider bug.',
          },
          {
            kind: 'p',
            text: 'Any model id the provider accepts is a valid id here. Discovery on the Providers screen is a convenience, never a constraint. You can confirm nothing local is consulted by asking for a model that does not exist — the error comes back in the provider’s own words.',
          },
          {
            kind: 'code',
            lang: 'text',
            code: "$ agent-eval runs start --model ollama/not-a-real-model:v9 …\nMODEL_NOT_FOUND: model 'not-a-real-model:v9' not found",
          },
        ],
      },
      {
        id: 'credentials',
        title: 'Storing provider credentials',
        summary: 'Three ways to store one, and exactly where the plaintext does and does not travel.',
        blocks: [
          { kind: 'h3', text: 'Dashboard' },
          {
            kind: 'p',
            text: 'Settings → Providers → the provider → Add credential. The secret is submitted once and cleared from component state immediately, including when the request fails. Afterwards only a masked form is shown, because that is the only representation the API returns.',
          },
          { kind: 'h3', text: 'CLI' },
          {
            kind: 'code',
            lang: 'bash',
            code: "export AGENT_EVAL_PROVIDER_KEY='sk-…'\nagent-eval credentials add --provider openai --name Production",
            caption: 'Read from the environment rather than a flag: arguments appear in shell history and in ps output, where a credential must not be.',
          },
          { kind: 'h3', text: 'SDK' },
          {
            kind: 'code',
            lang: 'ts',
            code: "await client.credentials.create({\n  providerId: 'openai',\n  name: 'Production',\n  apiKey: process.env.OPENAI_API_KEY,\n});",
          },
          { kind: 'h3', text: 'Where the plaintext goes' },
          {
            kind: 'table',
            headers: ['Location', 'Plaintext present?'],
            rows: [
              ['The HTTPS request that creates it', 'yes, once'],
              ['The stored record', 'no — AES-256-GCM ciphertext with an auth tag'],
              ['Any GET response', 'no — no endpoint returns it'],
              ['The audit log', 'no — the credential id is recorded, never the secret'],
              ['Evidence bundles', 'no'],
              ['Server logs', 'no — redaction applied at the boundary'],
              ['The browser after submission', 'no — cleared on both success and failure'],
              ['The outbound provider request', 'yes — decrypted immediately before the call'],
            ],
          },
          {
            kind: 'p',
            text: 'One function returns plaintext: revealForProviderCall. It is named that way so a reviewer can grep for its call sites and check every one. There are three, all server-side — the connection test, model discovery, and the worker.',
          },
        ],
      },
      {
        id: 'self-hosted',
        title: 'Self-hosted and compatible endpoints',
        summary: 'vLLM, LM Studio, Azure OpenAI, corporate gateways.',
        blocks: [
          {
            kind: 'p',
            text: 'Any endpoint speaking the OpenAI dialect works through the openai-compatible provider with a base URL. This covers vLLM, LM Studio, Together, OpenRouter, Azure OpenAI deployments and internal gateways.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval credentials add \\\n  --provider openai-compatible \\\n  --name "internal gateway" \\\n  --base-url https://llm.internal.example.com/v1',
          },
          {
            kind: 'p',
            text: 'Ollama needs no credential at all — only a base URL if it is not on http://127.0.0.1:11434.',
          },
        ],
      },
    ],
  },

  {
    id: 'runs',
    title: 'Running evaluations',
    sections: [
      {
        id: 'manifest',
        title: 'The run manifest',
        summary: 'Why the form is long: a number without a manifest is not evidence.',
        blocks: [
          {
            kind: 'p',
            text: 'Every run declares what it ran, on what, and how. The server validates this at submission rather than at bundle time, because a run that cannot describe itself produces a number rather than evidence — and discovering that after execution is too late to re-run under the same conditions.',
          },
          {
            kind: 'table',
            headers: ['Field', 'Why it is required'],
            rows: [
              ['environmentId + environmentDigest', 'A tag can move; a digest cannot. Without it the run is not re-creatable.'],
              ['taskSetId + taskSetVersion + split', 'Two runs on different task set versions are not comparable, however similar the scores look.'],
              ['verifierId + verifierVersion', 'A changed verifier changes the score without changing the model.'],
              ['model.identifier', 'provider/model-id. The worker routes on this string.'],
              ['sampling', 'Temperature and related settings. A comparison across different sampling is not a comparison.'],
              ['seed', 'Explicitly nullable — "this run was not seeded" is a fact worth recording, and an absent field cannot state it.'],
              ['toolchain', 'Platform and harness versions, at minimum.'],
              ['isolationBackend', 'Where code ran, or that a provider was called.'],
              ['retentionRules', 'At least one basis for keeping the evidence.'],
            ],
          },
        ],
      },
      {
        id: 'backends',
        title: 'Execution backends',
        summary: 'What this deployment can actually run, stated plainly.',
        blocks: [
          {
            kind: 'table',
            headers: ['Backend', 'Status', 'What it is'],
            rows: [
              ['model', 'available', 'Calls a model provider. No sandbox, because no untrusted code runs.'],
              ['local-process', 'available with AGENT_EVAL_LOCAL_EXEC=1', 'Runs a subprocess with NO isolation boundary.'],
              ['trusted-dev', 'available', 'Development only. No isolation.'],
              ['firecracker', 'NOT IMPLEMENTED', 'Designed, not built. A run configured for it fails with a reason.'],
              ['cloud-hypervisor', 'NOT IMPLEMENTED', 'As above.'],
              ['gvisor', 'NOT IMPLEMENTED', 'As above.'],
              ['kata', 'NOT IMPLEMENTED', 'As above.'],
            ],
          },
          {
            kind: 'note',
            tone: 'warn',
            title: 'Refusal rather than substitution',
            text: 'A run configured for an isolation boundary this deployment lacks fails. It is never quietly run somewhere less isolated, because the resulting evidence would attest to isolation that did not exist.',
          },
        ],
      },
      {
        id: 'worker',
        title: 'How a run executes',
        summary: 'queued to completed, and what is written at each step.',
        blocks: [
          {
            kind: 'list',
            ordered: true,
            items: [
              'The run is created as queued and run.started is appended to the audit log.',
              'A worker claims it atomically — this is what stops two workers executing the same run — and appends run.claimed.',
              'If the backend is unavailable, execution.unavailable and run.failed are appended with the reason, and nothing runs.',
              'For a model run: the stored credential is decrypted, model.request is appended with the provider, model, sampling and credential id — never the secret.',
              'The provider answers. model.response records the finish reason, latency and token counts exactly as reported; where the provider does not report a count the field is null rather than an estimate.',
              'verifier.result and execution.completed, then run.completed.',
            ],
          },
          {
            kind: 'p',
            text: 'The worker acts on behalf of the run’s tenant so entries land in the right isolation scope, but under its own actor identity — attributing machine execution to the human who queued it would misstate the record.',
          },
        ],
      },
    ],
  },

  {
    id: 'evidence',
    title: 'Evidence and audit',
    sections: [
      {
        id: 'audit-log',
        title: 'The audit log',
        summary: 'A hash chain committed to a Merkle tree, and what each structure proves.',
        blocks: [
          {
            kind: 'p',
            text: 'Every entry carries the hash of its predecessor, starting from a genesis value of sixty-four zeros. Removing or altering an entry breaks the chain from that point forward. Entries are also leaves of an RFC 6962 Merkle tree, which is a different and complementary claim.',
          },
          {
            kind: 'table',
            headers: ['Structure', 'Proves'],
            rows: [
              ['Hash chain', 'Nothing was removed from the middle of the log.'],
              ['Merkle inclusion proof', 'A specific entry is in the log with a given root — checkable without the rest of the log.'],
              ['Merkle consistency proof', 'An earlier root is a prefix of a later one; the log is append-only.'],
              ['Ed25519 signature', 'The bundle as a whole came from the holder of the signing key.'],
            ],
          },
          {
            kind: 'p',
            text: 'Entries are canonicalized with RFC 8785 before hashing, so the digest does not depend on key order or whitespace. Canonicalization rejects NaN, Infinity, negative zero and cycles rather than serialising something ambiguous.',
          },
        ],
      },
      {
        id: 'bundles',
        title: 'Evidence bundles',
        summary: 'What a bundle contains and what each part is for.',
        blocks: [
          {
            kind: 'p',
            text: 'A bundle covers one run. It contains the manifest and its digest, the run’s audit entries, the Merkle root and size at generation time, an inclusion proof for every entry, the retention determination, article mappings, and an Ed25519 signature over all of it.',
          },
          {
            kind: 'p',
            text: 'A bundle holds one run’s entries out of a shared log, so its sequence numbers usually start well above zero and contain gaps where other runs were interleaved. That is the filter, not tampering. What binds each entry to the log is its inclusion proof against the signed root; what binds the set together is the signature.',
          },
          {
            kind: 'note',
            tone: 'info',
            title: 'Article mappings are claims, with caveats attached',
            text: 'Mappings state what a bundle satisfies, supports, or exceeds for a given article, and carry a mandatory caveat where the claim is partial. A bundle that claimed unqualified compliance would be the least trustworthy thing in the system.',
          },
        ],
      },
      {
        id: 'verify',
        title: 'Verifying a bundle',
        summary: 'The only verification that counts is the one that does not involve this system.',
        blocks: [
          {
            kind: 'p',
            text: 'The server can verify its own bundles, which is convenient and worth nothing as an audit: it asks the system that produced the bundle whether the bundle is good. Real verification uses the downloaded file and a public key.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval evidence download bundle_abc123 --out bundle.json\nagent-eval evidence verify bundle.json',
          },
          {
            kind: 'p',
            text: 'That command reimplements RFC 8785, RFC 6962 and Ed25519 verification from the specifications and imports nothing from the server package. An auditor verifying with code the vendor also wrote is only checking that the vendor is self-consistent.',
          },
          {
            kind: 'table',
            headers: ['Check', 'What a failure means'],
            rows: [
              ['signature', 'The payload was altered, or it was not signed by the holder of that key.'],
              ['entryDigests', 'A specific entry was modified after it was written; the entry is named.'],
              ['ordering', 'The entry slice was reordered or contains a duplicate.'],
              ['inclusion', 'An entry is not provably in the log whose root the bundle cites.'],
              ['manifest', 'The manifest does not match its recorded digest.'],
            ],
          },
        ],
      },
    ],
  },

  {
    id: 'interfaces',
    title: 'API, SDK and CLI',
    sections: [
      {
        id: 'rest-api',
        title: 'REST API',
        summary: 'Thirty-four routes under /v1, with RFC 9457 problem+json errors throughout.',
        blocks: [
          {
            kind: 'p',
            text: 'A browsable OpenAPI UI is served at /docs on the control plane, which exists because a browser cannot set an Authorization header from the address bar.',
          },
          {
            kind: 'table',
            headers: ['Group', 'Routes'],
            rows: [
              ['Discovery', 'GET /v1, GET /v1/health, GET /v1/ready, GET /v1/me'],
              ['Runs', 'GET/POST /v1/runs, GET /v1/runs/:id, /manifest, /entries, POST /:id/cancel, POST /v1/runs/compare'],
              ['Providers', 'GET /v1/providers, POST /v1/providers/test, GET /v1/providers/:id/models'],
              ['Credentials', 'GET/POST /v1/provider-credentials, POST /v1/provider-credentials/:id/revoke'],
              ['Evidence', 'POST /v1/evidence/bundles, GET /:id, POST /:id/verify, GET /:id/offline, GET /v1/evidence/keys'],
              ['Audit', 'GET /v1/audit, /:seq, /:seq/inclusion-proof, /root, /consistency-proof, POST /v1/audit/verify'],
              ['Approvals', 'GET /v1/approvals, POST /v1/approvals/:id/decide'],
              ['API keys', 'GET/POST /v1/api-keys, GET /:id, POST /:id/revoke'],
            ],
          },
          {
            kind: 'p',
            text: 'Errors are problem+json and carry a reason, and often the offending field. A 401 always includes WWW-Authenticate, as RFC 9110 §11.6.1 requires.',
          },
        ],
      },
      {
        id: 'sdk',
        title: 'TypeScript SDK',
        summary: 'A typed client that never calls a provider and never returns a secret.',
        blocks: [
          {
            kind: 'code',
            lang: 'ts',
            code: "import { AgentEvalClient } from '@agent-eval/sdk';\n\nconst client = new AgentEvalClient({\n  baseUrl: 'http://127.0.0.1:8080',\n  apiKey: process.env.AGENT_EVAL_API_KEY!,\n});\n\nconst { items } = await client.providers.list();\nconst status = await client.providers.test('openai');\nconst models = await client.providers.models('anthropic');\n\nconst { runId } = await client.runs.start({ /* manifest */ });\nconst { bundleId } = await client.evidence.generate(runId, ['eu-ai-act-art-19']);",
          },
          {
            kind: 'p',
            text: 'There is deliberately no reveal method and no getter that returns a provider secret, because the API has no such route — the client cannot grow one by accident. There is also no model list and no provider enum in the package: both are runtime facts.',
          },
        ],
      },
      {
        id: 'cli',
        title: 'CLI',
        summary: 'Every command talks to a real endpoint; none of them fake success.',
        blocks: [
          {
            kind: 'code',
            lang: 'bash',
            code: 'export AGENT_EVAL_URL=http://127.0.0.1:8080\nexport AGENT_EVAL_API_KEY=ae_live_…\n\nagent-eval whoami\nagent-eval providers list\nagent-eval providers test ollama\nagent-eval models list --provider ollama\nagent-eval credentials add --provider openai --name Production\nagent-eval runs start --environment … --model openai/gpt-4o-mini …\nagent-eval runs get run_abc123\nagent-eval evidence generate run_abc123\nagent-eval evidence download bundle_abc123 --out bundle.json\nagent-eval evidence verify bundle.json\nagent-eval audit verify\nagent-eval keys create --name CI --scopes runs:read\nagent-eval roadmap',
          },
          {
            kind: 'p',
            text: 'agent-eval roadmap lists what the CLI does not do. It exists because three commands previously printed success for work they never performed — verifier fuzzing slept one second and reported completion, and server start printed a message without starting anything.',
          },
          {
            kind: 'p',
            text: 'A failed connection test sets a non-zero exit code, so it is usable in CI.',
          },
        ],
      },
    ],
  },

  {
    id: 'use-cases',
    title: 'Use cases',
    sections: [
      {
        id: 'eu-ai-act',
        title: 'EU AI Act conformity evidence',
        summary: 'Article 12 logging and Article 19 retention for a high-risk system.',
        blocks: [
          {
            kind: 'p',
            text: 'Article 12 requires high-risk systems to log automatically over their lifetime. Article 19 requires those logs kept at least six months. Article 17 requires a quality management system with documented, traceable procedures.',
          },
          {
            kind: 'p',
            text: 'The pattern: every pre-deployment evaluation runs through the control plane with retention eu-ai-act-art-19; a bundle is generated per run and archived. When a notified body asks what evidence supports a claim, you hand over bundles they can verify without access to your infrastructure. The article mappings inside each bundle state which obligation the record addresses and where the claim stops.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval runs start … --retention eu-ai-act-art-19,eu-ai-act-annex-iv',
            caption: 'Two bases; the longer floor governs, so this bundle is retained ten years.',
          },
        ],
      },
      {
        id: 'model-comparison',
        title: 'Defensible model comparison',
        summary: 'Proving two numbers can be compared before comparing them.',
        blocks: [
          {
            kind: 'p',
            text: 'The common failure in model comparison is not arithmetic — it is comparing runs that differ in task set version, verifier version, sampling or environment, and reporting the difference as a model difference.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval runs compare run_abc run_def',
          },
          {
            kind: 'p',
            text: 'The comparison reports whether the two are comparable and lists every manifest field that differs. A difference in sampling temperature makes the scores incomparable however close they look, and the platform says so rather than producing a delta.',
          },
        ],
      },
      {
        id: 'healthcare',
        title: 'Healthcare and other regulated deployments',
        summary: 'Six-year documentation retention, self-hosted, with no data leaving your infrastructure.',
        blocks: [
          {
            kind: 'p',
            text: 'HIPAA §164.316(b)(2)(i) requires documentation retained six years from creation or last effective date. Evaluation traces of a clinical assistant routinely contain protected health information, which is the reason this platform is self-hosted: sending traces to a vendor in order to prove compliance is a strange way to comply.',
          },
          {
            kind: 'p',
            text: 'Run with retention hipaa-164-316. Nothing leaves your network except the model provider calls you configure, and those carry only what your task set contains.',
          },
        ],
      },
      {
        id: 'incident',
        title: 'Incident reconstruction',
        summary: 'Answering what was evaluated, by whom, and when — months later.',
        blocks: [
          {
            kind: 'p',
            text: 'After a production incident the question is usually whether the deployed configuration was ever evaluated, and what the result was. The audit log answers it with entries that can be proven unaltered, and the manifests say exactly what was tested rather than approximately.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval audit query --subject run_abc123\nagent-eval audit query --actor someone@example.com --action run.started\nagent-eval audit verify',
          },
        ],
      },
      {
        id: 'ci',
        title: 'Continuous evaluation in CI',
        summary: 'A scoped key, a run per pipeline, evidence as a build artifact.',
        blocks: [
          {
            kind: 'p',
            text: 'Create a key with only runs:write and evidence:generate. The CLI exits non-zero on failure, so the pipeline fails when the control plane refuses a run or a provider is unreachable.',
          },
          {
            kind: 'code',
            lang: 'bash',
            code: 'agent-eval keys create --name "ci" --scopes runs:write,evidence:generate --expires-in-days 90\n\n# in the pipeline\nagent-eval runs start … --model openai/gpt-4o-mini\nagent-eval evidence generate "$RUN_ID"\nagent-eval evidence download "$BUNDLE_ID" --out evidence.json\nagent-eval evidence verify evidence.json',
          },
          {
            kind: 'p',
            text: 'Archiving evidence.json as a build artifact gives you a signed, independently verifiable record of every evaluation the pipeline ever ran.',
          },
        ],
      },
    ],
  },

  {
    id: 'limits',
    title: 'Limits and troubleshooting',
    sections: [
      {
        id: 'not-implemented',
        title: 'What is not implemented',
        summary: 'Stated explicitly, because documentation that omits gaps builds a wrong model.',
        blocks: [
          {
            kind: 'note',
            tone: 'warn',
            title: 'Read this before deploying',
            text: 'Everything below is absent, not partial. None of it fails silently — the platform refuses rather than pretending.',
          },
          {
            kind: 'table',
            headers: ['Area', 'Status'],
            rows: [
              ['Durable storage', 'NOT IMPLEMENTED. Storage is in-memory; evidence does not survive a restart.'],
              ['VM isolation backends', 'NOT IMPLEMENTED. firecracker, cloud-hypervisor, gvisor and kata are designed, not built.'],
              ['Egress control and credential brokering', 'NOT IMPLEMENTED. Part of the same isolation layer.'],
              ['Verifier fuzzing', 'NOT IMPLEMENTED. No code exists for it.'],
              ['Isomorphic perturbation testing', 'NOT IMPLEMENTED.'],
              ['Canary hack-tasks', 'NOT IMPLEMENTED.'],
              ['Trajectory capture', 'NOT IMPLEMENTED. Run detail shows real audit entries instead.'],
              ['splits:held-out enforcement', 'The scope is declared and grantable but not enforced on any route.'],
              ['WORM anchoring', 'Bundles record wormAnchored: false. There is no anchoring integration.'],
              ['OIDC', 'NOT IMPLEMENTED. Development tokens stand in; the claim shape is the same.'],
              ['Environment registry', 'No /environments API. Pass a digest to the run manifest.'],
            ],
          },
        ],
      },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        summary: 'The failures you are most likely to hit first, and what each one means.',
        blocks: [
          { kind: 'h3', text: '401 unauthenticated' },
          {
            kind: 'p',
            text: 'The token is missing or malformed. A development token needs all three parts: tenantId:actor:scopes. Note that scope names contain colons, so only the first two colons are separators.',
          },
          { kind: 'h3', text: '403 on an action you expected to work' },
          {
            kind: 'p',
            text: 'The scope is absent. GET /v1/me lists exactly what the current credential holds. Creating a key with a scope you do not hold is refused by design.',
          },
          { kind: 'h3', text: 'Credentials cannot be saved' },
          {
            kind: 'p',
            text: 'AGENT_EVAL_ENCRYPTION_KEY is unset or not 64 hex characters. The server refuses to store a secret it cannot encrypt rather than writing plaintext, and the Providers screen says so.',
          },
          { kind: 'h3', text: 'Runs stay queued forever' },
          {
            kind: 'p',
            text: 'Execution is disabled. GET /v1/ready reports 503 and says which flag is missing — AGENT_EVAL_MODEL_EXEC=1 for provider runs, AGENT_EVAL_LOCAL_EXEC=1 for subprocess runs.',
          },
          { kind: 'h3', text: 'A run fails with a provider error' },
          {
            kind: 'p',
            text: 'That message came from the provider, not from this platform. MODEL_NOT_FOUND means the provider does not have that model id; authentication_failed means it rejected the credential.',
          },
          { kind: 'h3', text: 'A run names a credential and fails immediately' },
          {
            kind: 'p',
            text: 'The credential was revoked, belongs to another tenant, or the worker has no access to the credential store. The run fails rather than falling back to environment variables, because it would then be paid for by a different key than the one it recorded.',
          },
          { kind: 'h3', text: 'Port already in use' },
          {
            kind: 'p',
            text: 'An earlier instance is still running, and it may be an older build. Stop it before starting a new one, or the new process exits with EADDRINUSE while the stale one keeps serving requests.',
          },
        ],
      },
    ],
  },
];

/** Flattened for search and for resolving a section id from the URL. */
export const ALL_SECTIONS: (DocSection & { groupTitle: string; groupId: string })[] =
  DOC_GROUPS.flatMap((g) =>
    g.sections.map((s) => ({ ...s, groupTitle: g.title, groupId: g.id })),
  );

/** Everything searchable in one section, flattened to plain text. */
export function sectionText(section: DocSection): string {
  const parts = [section.title, section.summary];
  for (const block of section.blocks) {
    switch (block.kind) {
      case 'p':
      case 'h3':
        parts.push(block.text);
        break;
      case 'code':
        parts.push(block.code, block.caption ?? '');
        break;
      case 'list':
        parts.push(...block.items);
        break;
      case 'table':
        parts.push(...block.headers, ...block.rows.flat());
        break;
      case 'note':
        parts.push(block.title, block.text);
        break;
    }
  }
  return parts.join(' · ');
}
