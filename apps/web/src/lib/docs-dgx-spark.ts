/**
 * DGX Spark documentation.
 *
 * Its own module because it is the one part of the documentation that quotes
 * an external vendor, and every figure in it needs a source. Keeping it
 * separate makes the citations reviewable in one place rather than scattered
 * through the general docs.
 *
 * Hardware and software figures below are taken from NVIDIA documentation
 * consulted in August 2026:
 *   https://docs.nvidia.com/dgx/dgx-spark/hardware.html
 *   https://docs.nvidia.com/dgx/dgx-spark/system-overview.html
 *   https://docs.nvidia.com/dgx/dgx-spark-porting-guide/porting/software-requirements.html
 *   https://docs.nvidia.com/dgx/dgx-spark/spark-clustering.html
 *   https://docs.nvidia.com/sync/latest/cluster-assistant.html
 *   https://build.nvidia.com/spark
 *
 * Nothing here is measured by this project. Where NVIDIA qualifies a number as
 * theoretical, the qualification travels with it.
 */

import type { DocGroup } from './docs-content';

export const DGX_SPARK_GROUP: DocGroup = {
  id: 'dgx-spark',
  title: 'DGX Spark',
  sections: [
    {
      id: 'dgx-spark-overview',
      title: 'Running on DGX Spark',
      summary:
        'DGX Spark is a supported compute platform for agent-eval — not a requirement, and not an affiliation.',
      blocks: [
        {
          kind: 'p',
          text: 'agent-eval turns local AI compute into a verifiable evaluation environment. NVIDIA DGX Spark is one place that compute can live: an Arm workstation with an integrated Grace Blackwell GPU, able to serve models locally through vLLM, TensorRT-LLM, NIM or Ollama while the control plane records what happened and signs the result.',
        },
        {
          kind: 'p',
          text: 'None of it is required. agent-eval runs the same way against remote providers on any machine, and every capability described here is detected at runtime rather than assumed. A deployment that is not a DGX Spark says so plainly and keeps working.',
        },
        {
          kind: 'note',
          tone: 'info',
          title: 'agent-eval is not an NVIDIA product',
          text: 'DGX Spark is a compute platform this software supports. The hardware figures on these pages come from NVIDIA documentation and are attributed; none are measured by this project.',
        },
      ],
    },
    {
      id: 'dgx-spark-hardware',
      title: 'Hardware, as NVIDIA documents it',
      summary:
        'The published specification, with the performance figures left qualified the way NVIDIA qualifies them.',
      blocks: [
        {
          kind: 'table',
          headers: ['Component', 'Specification'],
          rows: [
            ['SoC', 'NVIDIA Grace Blackwell, integrated GPU and CPU, 5th-generation Tensor Cores'],
            ['CPU', '20-core Arm (10 Cortex-X925 + 10 Cortex-A725)'],
            ['CUDA cores', '6,144'],
            ['Memory', '128 GB LPDDR5x unified, 256-bit interface, 4266 MHz'],
            ['Memory bandwidth', '273 GB/s'],
            ['Storage', '1 TB or 4 TB NVMe M.2 with self-encryption'],
            ['Networking', '10 GbE RJ-45, ConnectX-7 Smart NIC with 2x QSFP, Wi-Fi 7, Bluetooth 5.4'],
            ['Model size', 'AI models up to 200 billion parameters'],
          ],
        },
        {
          kind: 'note',
          tone: 'warn',
          title: 'The performance figure is theoretical',
          text: 'NVIDIA states up to 1,000 TOPS inference and up to 1 PFLOP at FP4 precision with sparsity. Both are peak theoretical numbers at a specific precision, with sparsity — not throughput any particular workload will reach. agent-eval never shows them as achieved performance, and reports measurements or nothing.',
        },
        {
          kind: 'p',
          text: 'Because CPU and GPU share one physical memory pool, GPU memory is not a separate budget on this platform. What a model may use is whatever the rest of the system is not already using, which is why the estimator takes a budget as input instead of assuming the full 128 GB is free.',
        },
      ],
    },
    {
      id: 'dgx-spark-software',
      title: 'Software stack and compatibility',
      summary: 'Versions from NVIDIA documentation, and what agent-eval needs from each.',
      blocks: [
        {
          kind: 'table',
          headers: ['Component', 'NVIDIA documents', 'agent-eval'],
          rows: [
            ['Base OS', 'Ubuntu 24.04 server image with desktop packages', 'Detected from /etc/dgx-release, else /etc/os-release'],
            ['Kernel', 'Linux 6.11-based NVIDIA Base OS', 'Reported, not required'],
            ['CUDA toolkit', 'CUDA 13.0, latest fully tested', 'Detected via nvcc, else the driver maximum, labelled as such'],
            ['Driver', 'R580.GA UDA launch driver', 'Detected via nvidia-smi'],
            ['Container runtime', 'NVIDIA Container Toolkit preinstalled', 'Detected as the "nvidia" runtime in docker info'],
            ['Architecture', 'arm64', 'Required for local GPU execution; checked before any container runs'],
          ],
        },
        {
          kind: 'p',
          text: 'The control plane has four runtime dependencies — Fastify, Zod and two Swagger packages — all pure JavaScript with no native bindings, so there is no architecture-specific build step to get wrong. What does need checking for arm64 is any container image a runtime pulls, which is why the preflight refuses rather than guesses.',
        },
      ],
    },
    {
      id: 'dgx-spark-install',
      title: 'Installation and preflight',
      summary: 'Clone, check the host, start, then confirm what the platform actually detected.',
      blocks: [
        {
          kind: 'code',
          lang: 'bash',
          code: 'git clone https://github.com/Ashutosh0x/agent-eval.git\ncd agent-eval\npnpm install\n\n# Verify the host before starting anything\npnpm dgx:check',
        },
        {
          kind: 'p',
          text: 'The check runs real probes and exits non-zero when a required one fails, so it works as a provisioning gate. Optional items — Docker, the NVIDIA container runtime, a serving runtime — report their state without failing, because agent-eval evaluates against remote providers without any of them.',
        },
        {
          kind: 'code',
          lang: 'bash',
          code: 'export AGENT_EVAL_ENCRYPTION_KEY=$(node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))")\nexport AGENT_EVAL_MODEL_EXEC=1\nexport VLLM_BASE_URL=http://127.0.0.1:8000/v1\n\ncd packages/server && npx tsx src/main.ts',
        },
        {
          kind: 'p',
          text: 'Then ask the running system about itself. This is the authoritative answer: the tables above describe DGX Spark in general, but only these endpoints describe your machine.',
        },
        {
          kind: 'code',
          lang: 'bash',
          code: 'curl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/capabilities\ncurl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/health\ncurl -H "Authorization: Bearer $TOKEN" localhost:8080/v1/system/runtimes',
        },
      ],
    },
    {
      id: 'dgx-spark-runtimes',
      title: 'Local model runtimes',
      summary: 'vLLM, TensorRT-LLM, NIM and Ollama — and what this platform will not claim about each.',
      blocks: [
        {
          kind: 'p',
          text: 'All four serve an OpenAI-compatible HTTP API, so agent-eval reaches them through the same transport it uses for hosted providers. A local model is an ordinary provider here: the evaluator resolves it from the registry like any other, and the evidence layer does not care where the tokens came from.',
        },
        {
          kind: 'table',
          headers: ['Runtime', 'DGX Spark position', 'Environment variable'],
          rows: [
            ['vllm', 'Documented — NVIDIA publishes a vLLM playbook for DGX Spark', 'VLLM_BASE_URL'],
            ['tensorrt-llm', 'Documented — TRT-LLM playbook, and listed in the software stack', 'TENSORRT_LLM_BASE_URL'],
            ['nim', 'Unknown — validated per container, not per platform', 'NIM_BASE_URL'],
            ['ollama', 'Documented — among the local deployment paths NVIDIA lists', 'OLLAMA_BASE_URL'],
          ],
        },
        {
          kind: 'note',
          tone: 'warn',
          title: 'NIM compatibility is per container',
          text: 'NVIDIA describes NIM as packaged containers for validated NIM-capable GPUs. That is a claim about particular containers, not about DGX Spark as a platform, so agent-eval reports NIM support as unknown and will not assert that any given NIM runs here. Check the container, then test the connection.',
        },
        {
          kind: 'p',
          text: 'Each runtime reports two things that are never merged: whether an endpoint was configured, and whether it answered. A base URL in the environment means somebody intended a runtime to exist. Only the request establishes that it does.',
        },
      ],
    },
    {
      id: 'dgx-spark-evidence',
      title: 'Hardware in the evidence',
      summary: 'What a bundle records about the machine that produced the result.',
      blocks: [
        {
          kind: 'p',
          text: 'When a worker claims a run it probes the host and stores the result on the run; the evidence bundle then carries it. That is what lets a reviewer answer "what actually produced this?" months later instead of trusting a filename.',
        },
        {
          kind: 'code',
          lang: 'json',
          code: '{\n  "platform": "linux",\n  "architecture": "arm64",\n  "kernel": "6.11.0-...",\n  "os": "DGX OS ...",\n  "cpuCores": 20,\n  "memoryTotalBytes": 137438953472,\n  "gpuName": "NVIDIA GB10",\n  "gpuComputeCapability": "12.1",\n  "cudaVersion": "13.0",\n  "driverVersion": "580...",\n  "deploymentTarget": "dgx-spark",\n  "dgxSpark": true\n}',
          caption:
            'Illustrative shape. Every field is omitted rather than guessed when a probe could not answer, so a bundle from a host without nvidia-smi carries no gpuName at all.',
        },
        {
          kind: 'p',
          text: 'The record deliberately excludes telemetry — free memory, utilisation, timestamps. Those differ between two runs of the same configuration and would make the field useless for the comparison it exists to support. A compute.node.selected entry enters the same hash-chained audit log as everything else; there is no second audit system.',
        },
      ],
    },
    {
      id: 'dgx-spark-cluster',
      title: 'Multiple DGX Spark systems',
      summary: 'What NVIDIA supports, and what agent-eval does and does not implement for it.',
      blocks: [
        {
          kind: 'table',
          headers: ['Topology', 'Maximum nodes', 'Source'],
          rows: [
            ['Direct QSFP cable', '3', 'NVIDIA Sync Cluster Assistant'],
            ['Through a switch', '4', 'NVIDIA Sync Cluster Assistant'],
            ['Per QSFP port', 'up to 200 Gb/s', 'DGX Spark ConnectX-7 documentation'],
          ],
        },
        {
          kind: 'note',
          tone: 'danger',
          title: 'Multi-node is documented here, not implemented',
          text: 'agent-eval has no node discovery, no cross-node scheduler and no distributed execution. The worker claims runs from one queue on one machine. Nothing here will spread a model across Sparks, and a cluster page fed by invented node data would be exactly the failure this project exists to prevent.',
        },
        {
          kind: 'p',
          text: 'What does work today: several DGX Spark systems each running their own agent-eval, or one control plane pointed at model runtimes serving on other machines through their base URLs. In the second arrangement the evidence records the control plane host, which is not the machine that ran the model — a limitation worth knowing before relying on it.',
        },
      ],
    },
    {
      id: 'dgx-spark-security',
      title: 'Security on DGX Spark',
      summary: 'What the platform will not do, however convenient it would be.',
      blocks: [
        {
          kind: 'list',
          items: [
            'No host command execution from the browser. The dashboard calls the API; the API runs a fixed set of probes with fixed argument vectors and never builds a command from request input.',
            'No Docker socket exposed to the frontend, and no container pull triggered by an unauthenticated caller.',
            'NGC and provider keys and the encryption key are read from the server environment. None reach VITE_ variables, browser storage, audit payloads or evidence bundles.',
            'Provider credentials are encrypted with AES-256-GCM bound to their tenant. The server refuses to store one it cannot encrypt rather than writing plaintext.',
            'Every system probe is read-only. Nothing in this layer starts, stops or modifies a container.',
          ],
        },
        {
          kind: 'note',
          tone: 'warn',
          title: 'Isolation is not provided by this platform',
          text: 'The VM isolation backends are designed and not built. A GPU container run through the NVIDIA container runtime shares the host kernel, which is a smaller boundary than a microVM, and evidence from such a run should be read accordingly. agent-eval records which backend was used so the distinction survives into the audit trail.',
        },
      ],
    },
    {
      id: 'dgx-spark-troubleshooting',
      title: 'DGX Spark troubleshooting',
      summary: 'The failures most likely to appear first, and what each one means.',
      blocks: [
        { kind: 'h3', text: 'Capabilities report dgxSpark: false on a real Spark' },
        {
          kind: 'p',
          text: 'Detection requires arm64 Linux plus a GPU naming GB10 or Grace Blackwell. The response carries an evidence array saying which condition failed. If nvidia-smi is unavailable inside a container, pass the GPU through — the probe reports what it can see, and a container without GPU access genuinely cannot see one.',
        },
        { kind: 'h3', text: 'A runtime shows configured but not connected' },
        {
          kind: 'p',
          text: 'Those are different claims and the split is deliberate. Configured means a base URL exists; connected means it answered. Check the runtime is serving on that address, and that it is not bound to localhost only while the control plane runs elsewhere.',
        },
        { kind: 'h3', text: 'A container fails to start on DGX Spark' },
        {
          kind: 'p',
          text: 'Check the image publishes a linux/arm64 manifest. An x86-only image is the most common cause, and on some configurations it fails at run time rather than pull time.',
        },
        { kind: 'h3', text: 'GPU containers will not start at all' },
        {
          kind: 'p',
          text: 'docker info must list a runtime named "nvidia". The system health endpoint reports this directly. Without it, --gpus all fails regardless of driver state.',
        },
      ],
    },
  ],
};
