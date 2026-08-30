# Agent Eval

An audit-grade, self-hosted evaluation control plane for agentic AI in
regulated environments.

It does not define a new environment format. It runs upstream environments
inside an isolation boundary and emits **tamper-evident, retention-compliant
evidence bundles** that a reviewer can verify without trusting the server that
produced them.

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-000000?style=flat-square&logo=fastify&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-087EA4?style=flat-square&logo=react&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white">
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white">
  <img alt="Zod" src="https://img.shields.io/badge/Zod-3E67B1?style=flat-square&logo=zod&logoColor=white">
  <img alt="Vitest" src="https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white">
  <img alt="Turborepo" src="https://img.shields.io/badge/Turborepo-EF4444?style=flat-square&logo=turborepo&logoColor=white">
  <img alt="OpenAPI" src="https://img.shields.io/badge/OpenAPI-6BA539?style=flat-square&logo=openapiinitiative&logoColor=white">
  <img alt="Open Policy Agent" src="https://img.shields.io/badge/OPA_Rego-7D9199?style=flat-square&logo=openpolicyagent&logoColor=white">
</p>

---

## Demo

[![Watch the demo](docs/media/demo-poster.jpg)](https://github.com/Ashutosh0x/agent-eval/raw/main/docs/media/agent-eval-demo.mp4)

*Click to play — 64 seconds. Providers, credential storage, a real run, and offline bundle verification.*

---

## The claim, and how to check it

An evidence bundle is verifiable with `node:crypto` and nothing else. Edit one
field inside a signed bundle and the independent verifier says so:

```
signature (ed25519):         INVALID
hash chain:                  BROKEN
merkle inclusion (RFC 6962): PROVEN
```

Two layers catch the edit. The third correctly still passes — that entry hash
genuinely *is* in the tree; what changed was its contents. Three checks
measuring three different things, not three copies of one.

Untampered, the same script reports `VALID / INTACT / PROVEN`.

---

## Quick start

```bash
pnpm install

# control plane on http://127.0.0.1:8080
pnpm --filter @agent-eval/server dev

# dashboard on http://127.0.0.1:5173
pnpm --filter @agent-eval/web dev
```

A browser cannot set an `Authorization` header, so there are two ways in:

| | |
| --- | --- |
| `http://127.0.0.1:5173` | The dashboard. Paste the development token on the first screen. |
| `http://127.0.0.1:8080/docs` | Swagger UI. Click **Authorize** and paste the same token. |

```
acme:you@example.test:runs:read,runs:write,evidence:read,evidence:generate,approvals:decide,audit:read
```

Format is `<tenantId>:<actor>:<comma-separated scopes>`. Everything before the
first colon is the tenant, so two different tenant strings give you two
isolated worlds to test against.

---

## The evidence layer

Pure, dependency-free beyond `node:crypto`, so the parts a regulator cares
about can be reimplemented from the RFC without running this code.

| Module | What it does |
| --- | --- |
| `merkle-tree.ts` | RFC 6962 tree, inclusion and consistency proofs |
| `proof-verifier.ts` | Verification that shares no tree-walking code with the prover |
| `audit-log.ts` | Hash-chained append-only log |
| `signer.ts` | Ed25519 over canonical JSON, with a KMS seam |
| `canonical.ts` | Deterministic serialization (RFC 8785 key ordering) |
| `reproducibility.ts` | Manifest pinning and comparability |
| `retention.ts` | Overlapping regimes, WORM assessment, expiry planning |
| `evidence-bundle.ts` | Signed, article-mapped bundle |

Three details are load-bearing.

**The verifier is independent.** A verifier built by calling into the prover
proves only that the prover is self-consistent. These reconstruct the root from
the proof alone.

**Hashes are combined as bytes, never as hex strings.** Measured: an
implementation that concatenates hex text computes a different root at 39 of
the first 40 tree sizes. The two look alike, are each internally consistent,
and never interoperate.

**Canonical JSON is not optional.** `JSON.stringify` preserves insertion order,
so the same value hashes two ways after a database round-trip. That failure
looks like tampering when nothing was touched.

---

## The bundle refuses to overclaim

Each regulatory mapping carries a strength, and anything that is not
`satisfies` must have a caveat — enforced by a test.

```
satisfies  EU AI Act Art. 12       automatic logging
exceeds    EU AI Act Art. 12       hash-chained and Merkle-committed
supports   EU AI Act Art. 14       approval decisions with identity
supports   EU AI Act Art. 17       reproducible runs
satisfies  EU AI Act Art. 19       retention floor enforced
satisfies  NIST AI RMF Measure 2.1 pinned TEVV documentation
supports   SR 11-7                 inputs for independent validation
```

> Article 12 does not require tamper-evidence. This is a stronger property than
> the text asks for and should not be presented as what makes the system
> compliant.

That caveat ships in the bundle. Art. 14, Art. 17 and SR 11-7 are `supports`,
not `satisfies`, because they are organisational obligations — an approval
queue evidences that oversight occurred without establishing that the
overseers were competent or independent.

The UI never renders a green-tick matrix. A checkmark column would collapse
that distinction and tell a compliance officer that "stronger than required"
means "required and met".

---

## API

26 routes, OpenAPI 3.1 at `/docs`. Three are public on purpose:

| Route | Why unauthenticated |
| --- | --- |
| `GET /v1` | A 401 that cannot tell you how to authenticate is a dead end |
| `GET /v1/health` | Liveness |
| `GET /v1/evidence/keys` | An auditor must verify a signature without an account here |

Seven scopes: `runs:read`, `runs:write`, `evidence:read`, `evidence:generate`,
`approvals:decide`, `audit:read`, `splits:held-out`.

Full surface and the run flow: [docs/api.md](docs/api.md).

### Deliberately not endpoints

- **No `DELETE /v1/audit/{seq}`.** An API that can delete an audit entry is not
  an append-only log, whatever the storage layer does underneath.
- **No `PATCH` on a run manifest.** A manifest describes what happened; editing
  it after the fact is falsification with an audit trail.
- **No "mark as compliant" action.** The system produces evidence. A conformity
  assessment is a human judgement.

---

## Dashboard

Two users share no vocabulary, and every comparable tool serves one of them.

| | Evaluation engineer | Compliance reviewer |
| --- | --- | --- |
| Wants | Traces, tool calls, diffs | Provenance, chain of custody, retention |
| Density | Very high | One claim at a time, with its basis |
| Environment | Dark, keyboard | Light, often printing to PDF |

The same record renders in two registers with an honest bridge between them.

**The Seal is not a badge.** Click "show working" and it shows the arithmetic:
each check passing or failing, the signing key, the expected root beside the
computed one, and for a broken chain the specific entry where it breaks.

Design tokens, verified contrast, and the icon inventory:
[docs/design-system.md](docs/design-system.md).

---

## What is not built

Stated plainly because a compliance product that overstates itself is worse
than one that admits gaps.

- **No trajectory ingestion.** A run carries a manifest, status and retention
  rules. There are no trials, steps or ATIF documents, so the run detail screen
  shows the run's real audit entries rather than a fabricated transcript, and
  its Graph tab says why it is empty.
- **No isolation layer.** The Firecracker supervisor, egress proxy and
  credential broker are designed but unbuilt. `isolationBackend` is recorded in
  the manifest, not enforced.
- **No adapters.** OpenEnv, Inspect AI and verifiers expose Python-only
  extension APIs, so that layer needs a Python sidecar regardless of what the
  TypeScript build plan says.
- **In-memory stores.** Evidence does not survive a restart. The store
  interface is shaped for Postgres with row-level security; the Prisma
  implementation is not written.
- **`splits:held-out` is declared but unenforced.** There is no task-set route
  to enforce it on yet.
- **Policies are not evaluated.** Six Rego files exist under `policies/`;
  nothing loads them.

---

## Layout

```
agent-eval/
├── packages/server/     Fastify control plane, evidence layer, API keys
│   └── src/
│       ├── evidence/    Merkle, audit log, signing, retention, bundles
│       ├── auth/        API keys
│       ├── api/         Routes and OpenAPI
│       ├── schemas/     Zod, shared with the client
│       └── store/       Storage seam — append-only by type
├── apps/web/            React dashboard
├── packages/cli/        Commander CLI
├── packages/sdk/        TypeScript client
├── policies/            OPA/Rego
└── docs/
```

`AuditStore` has no `update` or `delete` method. Not by convention — by type,
so no route can mutate history even by accident.

---

## Tests

```bash
pnpm --filter @agent-eval/server test    # 152
pnpm --filter @agent-eval/web test       #  14
```

The Merkle suite generates roughly 1,100 proofs across every tree size and leaf
position and checks each through the independent verifier. The API key suite is
mostly assertions of absence: a credential store is defined by its leaks.

---

## Local compute: NVIDIA DGX Spark

agent-eval turns local AI compute into a verifiable evaluation environment.
DGX Spark is a supported place to put that compute — not a requirement, and
not an affiliation.

```bash
pnpm dgx:check          # real probes; exits non-zero when a required one fails
```

The control plane detects what the host actually is and writes it into the
evidence bundle, so a reviewer can later establish which machine produced a
result:

```bash
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/capabilities
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/health
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/runtimes
```

Nothing is assumed. A host that is not a DGX Spark reports that, with the
reason, and keeps working against remote providers. Local runtimes — vLLM,
TensorRT-LLM, NIM, Ollama — are configured by base URL and report *configured*
and *connected* as separate facts.

| | |
| --- | --- |
| Hardware figures | Published by NVIDIA, attributed, never measured by this project |
| `1 PFLOP FP4` | NVIDIA's peak theoretical figure *with sparsity* — not throughput you will observe |
| Multi-Spark | Documented (NVIDIA supports up to 4 nodes via switch, 3 direct) — **not implemented here** |
| Hardware validation | **NOT RUN** — no DGX Spark was available; see [docs/dgx-spark.md](docs/dgx-spark.md) |

Full detail: **[DGX Spark deployment](docs/dgx-spark.md)**, or `/docs/dgx-spark-overview`
in the running dashboard.

---

## Documentation

The dashboard ships a searchable documentation site at **`/docs`** covering
setup, every configuration variable, providers and credentials, the run
manifest, evidence verification, use cases and troubleshooting. Search indexes
prose, code samples and table cells; press `/` to focus it.

```bash
pnpm dev            # then open http://localhost:5173/docs
```

The same material, as files:

| | |
| --- | --- |
| [Providers and credentials](docs/providers.md) | The nine providers, credential encryption, where a secret does and does not travel |
| [API and run flow](docs/api.md) | Every endpoint, the flow, and what is deliberately absent |
| [Design system](docs/design-system.md) | Tokens with measured contrast, icons, accessibility |

---

## Status

A working evidence layer and control plane API with a dashboard over it. The
isolation and adapter layers that would make it an evaluation platform are
designed and unbuilt.

Before building further: the thesis rests on regulated buyers wanting
self-hosted, evidence-producing agent evaluation, and that demand is
analogised from adjacent categories rather than measured. Worth two or three
design partners confirming they would pay before the remaining layers are
built.

## License

Apache-2.0
