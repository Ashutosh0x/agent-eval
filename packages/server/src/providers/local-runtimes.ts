/**
 * Local inference runtimes.
 *
 * vLLM, TensorRT-LLM (through trtllm-serve) and NIM all expose an
 * OpenAI-compatible HTTP surface, so they need a configuration object here
 * rather than an adapter. Writing three new transports that spoke the same
 * protocol would have tripled the surface where a bug can hide while adding
 * nothing — the difference between these runtimes is where they run and what
 * they need configured, not how you talk to them.
 *
 * What is genuinely different is recorded below: whether a credential is
 * needed, whether a base URL must be supplied, and what this platform can
 * honestly say about DGX Spark compatibility.
 *
 * Sources for the compatibility notes, checked August 2026:
 *   https://build.nvidia.com/spark              — vLLM and TRT-LLM playbooks
 *   https://docs.nvidia.com/dgx/dgx-spark/software.html
 *   https://docs.nvidia.com/dgx/dgx-spark-porting-guide/porting/software-requirements.html
 */

import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * How well a runtime is known to work on DGX Spark.
 *
 * `unknown` is a real value and the default for anything NVIDIA has not
 * documented for this platform. It is not a soft "probably yes": the UI shows
 * it as unestablished, and the run still goes ahead if the operator chooses,
 * because the runtime answering is the only test that settles it.
 */
export type PlatformSupport = 'documented' | 'unsupported' | 'unknown';

export interface RuntimeDescriptor {
  id: string;
  displayName: string;
  /** Where it runs: on this machine, or somewhere reachable over the network. */
  locality: 'local' | 'remote';
  /** NVIDIA's documented position for DGX Spark, with the reason. */
  dgxSpark: { support: PlatformSupport; note: string };
  /** True when the operator must supply a base URL; there is no sane default. */
  requiresBaseUrl: boolean;
  defaultPort?: number;
}

export const RUNTIME_DESCRIPTORS: RuntimeDescriptor[] = [
  {
    id: 'vllm',
    displayName: 'vLLM',
    locality: 'local',
    dgxSpark: {
      support: 'documented',
      note: 'NVIDIA publishes a vLLM playbook for DGX Spark and lists vLLM among the backends it collaborated on for local deployment.',
    },
    requiresBaseUrl: false,
    defaultPort: 8000,
  },
  {
    id: 'tensorrt-llm',
    displayName: 'TensorRT-LLM',
    locality: 'local',
    dgxSpark: {
      support: 'documented',
      note: 'NVIDIA publishes a TensorRT-LLM playbook for DGX Spark, and TensorRT-LLM is listed in the DGX Spark software stack.',
    },
    requiresBaseUrl: false,
    defaultPort: 8000,
  },
  {
    id: 'nim',
    displayName: 'NVIDIA NIM',
    locality: 'local',
    dgxSpark: {
      // Deliberately not "documented". NVIDIA describes NIM as packaged
      // containers for validated NIM-capable GPUs, which is a per-container
      // claim rather than a platform-wide one. Presenting every NIM as
      // Spark-compatible would be inventing a guarantee NVIDIA has not made.
      support: 'unknown',
      note: 'NIM containers are validated per GPU. Whether a specific NIM supports DGX Spark must be checked for that container; this platform will not assert it.',
    },
    requiresBaseUrl: true,
    defaultPort: 8000,
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    locality: 'local',
    dgxSpark: {
      support: 'documented',
      note: 'NVIDIA lists Ollama among the local deployment paths it collaborated on for DGX Spark.',
    },
    requiresBaseUrl: false,
    defaultPort: 11434,
  },
];

export function describeRuntime(id: string): RuntimeDescriptor | undefined {
  return RUNTIME_DESCRIPTORS.find((r) => r.id === id);
}

/**
 * vLLM's OpenAI-compatible server.
 *
 * No credential by default: a locally served model usually has none, and
 * requiring one would make the common case look misconfigured. vLLM can be
 * started with --api-key, and supplying one here still works because the
 * transport sends a bearer token whenever a key is present.
 */
export const vllmProvider = new OpenAICompatibleProvider({
  id: 'vllm',
  displayName: 'vLLM',
  defaultBaseUrl: 'http://127.0.0.1:8000/v1',
  capabilities: {
    requiresApiKey: false,
    modelListing: 'supported',
    vision: 'unknown',
    structuredOutput: 'unknown',
  },
});

/**
 * TensorRT-LLM through trtllm-serve, which speaks the OpenAI protocol.
 *
 * Engine build configuration — precision, quantisation, max batch and input
 * length — is fixed when the engine is compiled, not when it is queried. That
 * metadata matters for reproducibility and is recorded on the run rather than
 * discovered here, because the serving endpoint does not report it.
 */
export const tensorRtLlmProvider = new OpenAICompatibleProvider({
  id: 'tensorrt-llm',
  displayName: 'TensorRT-LLM',
  defaultBaseUrl: 'http://127.0.0.1:8000/v1',
  capabilities: {
    requiresApiKey: false,
    modelListing: 'supported',
    vision: 'unknown',
    structuredOutput: 'unknown',
  },
});

/**
 * NVIDIA NIM.
 *
 * No default base URL: a NIM is a container the operator has started
 * somewhere, and guessing localhost would produce a connection error that
 * looks like the NIM is broken rather than unconfigured. An NGC key is needed
 * to pull the container, not to query it once running — so requiresApiKey is
 * false here, and the pull credential is handled separately and server-side.
 */
export const nimProvider = new OpenAICompatibleProvider({
  id: 'nim',
  displayName: 'NVIDIA NIM',
  capabilities: {
    requiresApiKey: false,
    modelListing: 'supported',
    vision: 'unknown',
    structuredOutput: 'unknown',
  },
});

/**
 * SGLang's OpenAI-compatible server.
 *
 * Default port 30000, which is SGLang's own default rather than the 8000 vLLM
 * uses — guessing the wrong one produces a connection error that reads like
 * the server is down instead of unconfigured.
 */
export const sglangProvider = new OpenAICompatibleProvider({
  id: 'sglang',
  displayName: 'SGLang',
  defaultBaseUrl: 'http://127.0.0.1:30000/v1',
  capabilities: {
    requiresApiKey: false,
    modelListing: 'supported',
    vision: 'unknown',
    structuredOutput: 'unknown',
  },
});

/**
 * Hugging Face Text Generation Inference.
 *
 * TGI serves a single model per process, so `/models` returns that one entry
 * and the model id in a request is effectively ignored. That is why the
 * registry records the operator's declared identifier: the endpoint cannot
 * tell you which weights it loaded in a way that distinguishes two TGI servers.
 */
export const tgiProvider = new OpenAICompatibleProvider({
  id: 'tgi',
  displayName: 'Text Generation Inference',
  defaultBaseUrl: 'http://127.0.0.1:8080/v1',
  capabilities: {
    requiresApiKey: false,
    modelListing: 'unknown',
    vision: 'unknown',
    structuredOutput: 'unknown',
  },
});

/**
 * LM Studio's local server. Default port 1234.
 *
 * Desktop software a user starts by hand, so the endpoint being absent is the
 * normal state rather than an error — the connection test says "not running"
 * rather than "misconfigured".
 */
export const lmStudioProvider = new OpenAICompatibleProvider({
  id: 'lmstudio',
  displayName: 'LM Studio',
  defaultBaseUrl: 'http://127.0.0.1:1234/v1',
  capabilities: {
    requiresApiKey: false,
    modelListing: 'supported',
    vision: 'unknown',
    structuredOutput: 'unknown',
  },
});
