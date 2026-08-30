# DGX Spark deployment

agent-eval turns local AI compute into a verifiable evaluation environment.
NVIDIA DGX Spark is a supported compute platform for it. **agent-eval is not an
NVIDIA product**, and every hardware figure on this page is quoted from NVIDIA
documentation rather than measured by this project.

> **Hardware validation status: NOT RUN.** No DGX Spark was available during
> implementation. Everything here was built and tested on architecture-independent
> paths; the commands under [Validation](#validation-on-real-hardware) are what
> remains to be run on real hardware, and none of them have been.

## What is implemented

| Capability | Status |
| --- | --- |
| Host capability detection (arch, GPU, CUDA, driver, Docker, NVIDIA runtime, OS) | Implemented |
| DGX Spark identification, with the evidence for the verdict | Implemented |
| Component health reporting, per component, with reasons | Implemented |
| Local runtime adapters — vLLM, TensorRT-LLM, NIM, Ollama | Implemented |
| Runtime connection testing (real requests) | Implemented |
| Conservative model memory estimation | Implemented |
| Hardware recorded into the run and the evidence bundle | Implemented |
| `compute.node.selected` in the existing hash-chained audit log | Implemented |
| Preflight script (`pnpm dgx:check`) | Implemented |
| Compute dashboard driven entirely by the API | Implemented |
| Multi-node clustering | **Not implemented** — documented only |
| Container pull / lifecycle management | **Not implemented** |
| NGC container browsing | **Not implemented** |
| Benchmark suite | **Not implemented** |
| GPU isolation boundary | **Not implemented** — see [Security](#security) |

## Hardware, as NVIDIA documents it

| Component | Specification |
| --- | --- |
| SoC | NVIDIA Grace Blackwell, integrated GPU and CPU, 5th-gen Tensor Cores |
| CPU | 20-core Arm (10 Cortex-X925 + 10 Cortex-A725) |
| CUDA cores | 6,144 |
| Memory | 128 GB LPDDR5x unified, 256-bit, 4266 MHz |
| Memory bandwidth | 273 GB/s |
| Storage | 1 TB or 4 TB NVMe M.2, self-encrypting |
| Networking | 10 GbE RJ-45, ConnectX-7 with 2× QSFP, Wi-Fi 7, Bluetooth 5.4 |
| Model size | AI models up to 200 billion parameters |

NVIDIA states **"up to 1,000 TOPS inference and up to 1 PFLOP at FP4 precision
with sparsity"**. Both are peak theoretical figures at a specific precision,
with sparsity. agent-eval never displays them as achieved performance.

Because CPU and GPU share one memory pool, "GPU memory" is not a separate
budget. The memory estimator therefore takes a budget as input rather than
assuming 128 GB is free.

## Software stack

| Component | NVIDIA documents | agent-eval |
| --- | --- | --- |
| Base OS | Ubuntu 24.04 server image with desktop packages | Detected from `/etc/dgx-release`, else `/etc/os-release` |
| Kernel | Linux 6.11-based NVIDIA Base OS | Reported, not required |
| CUDA toolkit | CUDA 13.0, latest fully tested | `nvcc`, else the driver maximum, labelled as such |
| Driver | R580.GA UDA launch driver | `nvidia-smi` |
| Container runtime | NVIDIA Container Toolkit, preinstalled | The `nvidia` runtime in `docker info` |
| Architecture | arm64 | Required for local GPU execution |

## ARM64 dependency audit

The control plane's runtime dependencies are `fastify`, `zod`,
`@fastify/swagger` and `@fastify/swagger-ui` — all pure JavaScript with no
native bindings, so there is no architecture-specific build step. The CLI adds
`commander`, `chalk` and `ora`; the SDK has none. The dashboard is built by
Vite and served as static assets.

There is **no Prisma** in this repository and **no Go binary**, so neither the
Prisma engine `binaryTargets` question nor Go cross-compilation applies here.
(Both were raised as concerns; neither exists in this codebase.)

What does need checking for arm64 is any **container image** a runtime pulls.
The preflight fails on a non-arm64 host rather than letting that surface later
as a confusing container error.

## Installation

```bash
git clone https://github.com/Ashutosh0x/agent-eval.git
cd agent-eval
pnpm install
pnpm dgx:check
```

`dgx:check` runs real probes. Required checks (Linux, arm64, an NVIDIA GPU,
Node ≥ 20) fail the script with exit 1. Optional ones (Docker, the NVIDIA
container runtime, a serving runtime, the encryption key) report their state
without failing, because agent-eval evaluates against remote providers without
any of them.

```bash
export AGENT_EVAL_ENCRYPTION_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
export AGENT_EVAL_MODEL_EXEC=1
export VLLM_BASE_URL=http://127.0.0.1:8000/v1

cd packages/server && npx tsx src/main.ts
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `AGENT_EVAL_ENCRYPTION_KEY` | 64 hex chars. Required to store provider credentials. |
| `AGENT_EVAL_MODEL_EXEC` | `1` to allow runs that call a model provider. |
| `VLLM_BASE_URL` | vLLM OpenAI-compatible endpoint. |
| `TENSORRT_LLM_BASE_URL` | `trtllm-serve` endpoint. |
| `NIM_BASE_URL` | A running NIM container. No default — see below. |
| `OLLAMA_BASE_URL` | Defaults to `http://127.0.0.1:11434`. |

Only variables backed by an implementation are listed. `NGC_API_KEY` is
deliberately absent: nothing in this codebase pulls a container, so accepting
the variable would imply a capability that does not exist.

## Local model runtimes

All four serve an OpenAI-compatible HTTP API, so they use the same transport as
hosted providers. A local model is an ordinary provider here.

| Runtime | DGX Spark position | Variable |
| --- | --- | --- |
| `vllm` | Documented — NVIDIA publishes a vLLM playbook | `VLLM_BASE_URL` |
| `tensorrt-llm` | Documented — TRT-LLM playbook; in the software stack | `TENSORRT_LLM_BASE_URL` |
| `nim` | **Unknown** — validated per container, not per platform | `NIM_BASE_URL` |
| `ollama` | Documented — among NVIDIA's listed local paths | `OLLAMA_BASE_URL` |

NVIDIA describes NIM as packaged containers for *validated NIM-capable GPUs*.
That is a per-container claim, so agent-eval reports NIM support as `unknown`
and will not assert that a given NIM runs on DGX Spark.

`configured` and `connected` are separate fields everywhere. A base URL means
somebody intended a runtime to exist; only the request establishes that it does.

## Evidence

When a worker claims a run it probes the host and stores the result; the bundle
then carries it:

```json
{
  "platform": "linux",
  "architecture": "arm64",
  "kernel": "6.11.0-...",
  "os": "DGX OS ...",
  "cpuCores": 20,
  "memoryTotalBytes": 137438953472,
  "gpuName": "NVIDIA GB10",
  "gpuComputeCapability": "12.1",
  "cudaVersion": "13.0",
  "driverVersion": "580...",
  "deploymentTarget": "dgx-spark",
  "dgxSpark": true
}
```

Fields are **omitted rather than guessed** when a probe could not answer. The
record excludes telemetry (free memory, utilisation, timestamps) so two runs of
one configuration produce identical records. A `compute.node.selected` entry
enters the existing hash-chained audit log; there is no second audit system.

## Multi-Spark

NVIDIA's Cluster Assistant supports **two to four** DGX Spark devices: direct
QSFP cabling supports two or three, a switch supports up to four. Each QSFP
port provides up to 200 Gb/s.

**agent-eval does not implement any of this.** There is no node discovery, no
cross-node scheduler and no distributed execution. The worker claims runs from
one queue on one machine. A cluster page fed by invented node data would be the
exact failure this project exists to prevent.

What works today: several Sparks each running their own agent-eval, or one
control plane pointed at runtimes serving on other machines by base URL. In the
second arrangement the evidence records the *control plane* host, not the
machine that ran the model — know that before relying on it.

## Security

- No host command execution from the browser. The API runs a fixed set of
  probes with fixed argument vectors; nothing interpolates request input into a
  command line.
- No Docker socket exposed to the frontend; no container pull path exists at all.
- Credentials are read from the server environment and encrypted with
  AES-256-GCM bound to their tenant. None reach `VITE_` variables, browser
  storage, audit payloads or evidence bundles.
- Every system probe is read-only.

**Isolation is not provided.** The VM isolation backends are designed and not
built. A GPU container run through the NVIDIA container runtime shares the host
kernel — a smaller boundary than a microVM. agent-eval records which backend was
used so the distinction survives into the audit trail.

Firecracker specifically: it is **not** appropriate here as currently designed.
GPU passthrough to a Firecracker microVM is not part of this codebase, and
nothing was forced onto the platform to pretend otherwise.

## Validation on real hardware

None of the following has been run. On a DGX Spark:

```bash
# 1. Preflight — expect arm64 and a GB10 GPU to pass
pnpm dgx:check

# 2. Detection — expect dgxSpark.detected true, with evidence
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/capabilities

# 3. Health — expect docker and nvidiaContainerRuntime ok
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/health

# 4. Start a runtime, then confirm it is seen
export VLLM_BASE_URL=http://127.0.0.1:8000/v1
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/runtimes

# 5. Run an evaluation against it
agent-eval runs start --model vllm/<model-id> --backend model ...

# 6. Confirm hardware reached the evidence
curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/runs/<id>/environment
agent-eval evidence generate <id>
agent-eval evidence download <bundle> --out bundle.json
agent-eval evidence verify bundle.json
```

Step 6 is the one that matters: the bundle should carry `gpuName: NVIDIA GB10`
and verify offline.

## Sources

All consulted August 2026:

- [DGX Spark hardware](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)
- [DGX Spark system overview](https://docs.nvidia.com/dgx/dgx-spark/system-overview.html)
- [DGX Spark software stack (porting guide)](https://docs.nvidia.com/dgx/dgx-spark-porting-guide/porting/software-requirements.html)
- [ConnectX-7 networking / clustering](https://docs.nvidia.com/dgx/dgx-spark/spark-clustering.html)
- [NVIDIA Sync Cluster Assistant](https://docs.nvidia.com/sync/latest/cluster-assistant.html)
- [DGX Spark playbooks](https://build.nvidia.com/spark)
- [DGX Spark user guide](https://docs.nvidia.com/dgx/dgx-spark/)
