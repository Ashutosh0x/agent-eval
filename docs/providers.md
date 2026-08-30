# Model providers and credentials

## The shape of the problem

An evaluation control plane has to call model providers on your behalf, which
means it has to hold credentials that can spend money. Two design decisions
follow from that, and everything else in this document is a consequence.

**The browser never holds a provider key.** The dashboard talks only to the
control plane; the control plane talks to OpenAI. If the frontend called
providers directly, the key would have to reach the browser, where it is
readable by any script on the page, visible in devtools, and present in every
error report. There is no configuration that turns this on.

**No model list is compiled into anything.** Not the server, not the SDK, not
the CLI, not the dashboard. Models are discovered from the provider at runtime,
and any id the provider accepts is a valid id here. A hardcoded list is wrong
within days of a provider release and wrong silently — the model exists, the
platform refuses it, and the refusal looks like a bug in the provider.

## Registered providers

| id | Provider | Credential | Model listing | Wire format |
|---|---|---|---|---|
| `openai` | OpenAI | required | supported | OpenAI |
| `anthropic` | Anthropic | required | supported | Anthropic Messages |
| `xai` | xAI | required | supported | OpenAI-compatible |
| `google` | Google Gemini | required | supported | Gemini generateContent |
| `deepseek` | DeepSeek | required | supported | OpenAI-compatible |
| `mistral` | Mistral | required | supported | OpenAI-compatible |
| `minimax` | MiniMax | required | unknown | OpenAI-compatible |
| `ollama` | Ollama | none | supported | Ollama |
| `openai-compatible` | Any compatible endpoint | required | unknown | OpenAI-compatible |

Six of these share one transport, because they genuinely speak the same
protocol; only Anthropic, Google and Ollama have wire formats different enough
to need their own adapter. Adding a seventh OpenAI-compatible provider is a
configuration object, not an implementation.

`unknown` in the listing column is a real value and not a synonym for `no`. It
means nobody has established whether the provider exposes an enumeration API.
Discovery will attempt it and report what comes back, because a failed probe is
itself information.

## Capabilities

Each provider reports capabilities as `supported`, `unsupported`, or `unknown`.
The third value exists because the alternative is to guess, and a guess that
renders as a definite answer is worse than an admission. Where a provider does
not document whether it supports, say, logprobs, the platform says `unknown`
rather than picking the more convenient answer.

## Configuring a credential

### Prerequisite: an encryption key

Provider credentials are encrypted with AES-256-GCM before they are stored.
The master key comes from the environment:

```bash
export AGENT_EVAL_ENCRYPTION_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
```

There is no default and no fallback. A hardcoded key would be identical in
every deployment and published in this repository, which offers the appearance
of encryption and none of the protection. With the variable unset, the server
**refuses to store a credential** rather than writing it in plaintext — the
dashboard says so, and the API returns 503 with an explanation.

The key must be 64 hex characters (32 bytes). Losing it makes stored
credentials undecryptable; they must be re-entered.

### Through the dashboard

Settings → Providers → the provider → Add credential. The secret is submitted
once and cleared from component state immediately, including when the request
fails. Afterwards the dashboard shows only a masked form (`sk-••••••••••3f9a`),
because that is the only representation the API will return.

### Through the CLI

```bash
export AGENT_EVAL_PROVIDER_KEY='sk-…'
agent-eval credentials add --provider openai --name Production
```

The secret is read from the environment rather than an argument. A
`--api-key` flag would put the credential into shell history and into `ps`
output, where anyone on the machine can read it.

### Through the SDK

```ts
await client.credentials.create({
  providerId: 'openai',
  name: 'Production',
  apiKey: process.env.OPENAI_API_KEY,
});
```

### Self-hosted and compatible endpoints

`baseUrl` targets a specific deployment — vLLM, LM Studio, a corporate gateway,
Azure OpenAI:

```bash
agent-eval credentials add \
  --provider openai-compatible \
  --name "internal gateway" \
  --base-url https://llm.internal.example.com/v1
```

Ollama needs no credential at all; only a base URL if it is not on
`http://127.0.0.1:11434`.

## Where the secret goes, and where it does not

| | Plaintext present? |
|---|---|
| The HTTPS request that creates it | yes, once |
| The database row | no — AES-256-GCM ciphertext with an auth tag |
| Any GET response | no — no endpoint returns it |
| The audit log | no — the credential *id* is recorded, never the secret |
| Evidence bundles | no |
| Server logs | no — redaction is applied at the boundary |
| The browser after submission | no — cleared from state on both paths |
| The outbound provider request | yes — decrypted immediately before the call |

The one function that returns plaintext is
`ProviderCredentialStore.revealForProviderCall`. It is named that way so a
reviewer can grep for its call sites and check every one. There are three, all
server-side: the connection test, model discovery, and the worker's resolver
in `main.ts`. No route returns what it produces.

Ciphertext is bound to its tenant and record with GCM additional authenticated
data (`agent-eval:provider-credential:${tenantId}:${id}`). A row copied to
another tenant will not decrypt, so a database-level attacker cannot hand one
tenant another's credential without breaking the cryptography.

## Connection status

A provider that has not been tested has **no status**. Not a grey pill, not
"unknown, probably fine" — nothing, plus a button. `POST /v1/providers/test`
makes a real request and reports what happened:

| Status | Meaning |
|---|---|
| `connected` | The provider answered. |
| `not_configured` | No credential is available for it. |
| `authentication_failed` | The provider rejected the credential. |
| `unavailable` | The endpoint could not be reached. |
| `error` | Something else; the detail carries the provider's own message. |

"A credential is stored" and "the credential works" are separate claims, shown
separately. Conflating them is how a dashboard displays green while every run
fails.

## Model discovery

```bash
agent-eval models list --provider anthropic
```

This asks the provider. The response is timestamped so a list read ten minutes
ago cannot be mistaken for current state. If the call fails, the error says so
and points at manual entry — it does not fall back to a cached or built-in
list, because a wrong list that looks right is the failure mode this design
exists to avoid.

To confirm nothing local is consulted, ask for a model that does not exist:

```
$ agent-eval runs start --model ollama/not-a-real-model:v9 …
model 'not-a-real-model:v9' not found
```

That message is Ollama's, not the platform's.

## Running against a provider

```bash
agent-eval runs start \
  --environment local/ollama \
  --digest sha256:3f3f…3f \
  --task-set smoke --task-set-version 1 \
  --verifier manual --verifier-version 1 \
  --model ollama/gemma3:4b \
  --credential cred_abc123 \
  --backend model \
  --retention eu-ai-act-art-19
```

`--model` is `<provider>/<model-id>`. The worker splits on the first slash and
resolves the provider from the registry; anything else cannot be routed, and
the run fails saying so rather than guessing.

`--backend model` selects the executor that calls a provider. The isolation
backends (`firecracker`, `gvisor`, …) are about where *code* runs and are a
separate axis; this deployment does not implement them, and a run configured
for one fails with a reason rather than quietly running somewhere less
isolated.

`--credential` names a stored credential. Omit it and the run uses the server's
environment variables instead. If a run names a credential the worker cannot
reach, it fails — it does not fall back to the environment, because the run
would then be paid for by a different key than the one it recorded.

## What the audit log records

```
model.request   { provider, model, sampling, baseUrl, credentialId }
model.response  { provider, model, finishReason, latencyMs,
                  inputTokens, outputTokens, totalTokens, text }
```

Every number there comes from the provider's response. Nothing is estimated,
and where a provider does not report token counts the field is `null` rather
than a guess.

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENT_EVAL_ENCRYPTION_KEY` | 64 hex chars. Required to store credentials. |
| `AGENT_EVAL_MODEL_EXEC` | `1` to allow runs that call providers. |
| `OPENAI_API_KEY` etc. | Per-provider fallback when no stored credential is named. |
| `AGENT_EVAL_PROVIDER_KEY` | Read by `credentials add` only. |

## Adding a provider

If it speaks the OpenAI dialect, add an instance to
`packages/server/src/providers/openai-compatible.ts`:

```ts
export const acmeProvider = new OpenAICompatibleProvider({
  id: 'acme',
  displayName: 'Acme',
  defaultBaseUrl: 'https://api.acme.example/v1',
  capabilities: { modelListing: 'unknown', vision: 'unknown' },
});
```

Register it, add its environment variable to `ENV_KEYS`, and it appears in the
dashboard, the CLI and the SDK without any of them changing. If it speaks a
different protocol, implement `ModelProvider` — `anthropic.ts` is the shortest
example.

Do not add a model list. There is nowhere to put one, which is deliberate.
