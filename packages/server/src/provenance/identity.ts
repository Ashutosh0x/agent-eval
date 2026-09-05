/**
 * Model identity, separated from deployment identity.
 *
 * THE DISTINCTION THIS FILE EXISTS TO MAKE:
 *
 *   Qwen3-8B served by vLLM on an H100
 *   Qwen3-8B served by NIM on an H100
 *   Qwen3-8B served by Ollama on a laptop
 *
 * are ONE model and THREE deployments. Collapsing them loses the ability to
 * ask the question the whole platform is for — "is this difference the model,
 * the runtime, or the hardware?" — and conflating them the other way makes a
 * leaderboard claim that a quantised laptop deployment and a datacentre one
 * are interchangeable.
 *
 * So a result is always attributed to a (ModelIdentity, DeploymentIdentity)
 * pair. Aggregating across deployments is then an explicit, visible choice
 * rather than an accident of the schema.
 *
 * WHERE QUANTISATION LIVES, and why it is arguable. Quantisation is recorded
 * on the DEPLOYMENT. A runtime that quantises fp16 weights at load time has
 * not changed which model was trained. When the quantised weights are
 * themselves a distinct published artifact — a separate repository or revision
 * — the model identity already differs by repo and revision, so the two cases
 * resolve correctly without a special rule.
 *
 * NEUTRALITY. Nothing here names a vendor. NVIDIA, Hugging Face, AMD and a
 * bare CPU are values, never branches. A `provider` field holding "nvidia" is
 * data; an `if (provider === 'nvidia')` in this layer would be the bug this
 * file is written to prevent.
 */

import { createHash } from 'node:crypto';

// --------------------------------------------------------------- model

/**
 * Where a model's weights came from.
 *
 * `hub` covers any model registry — Hugging Face is one, and is not privileged
 * here. `proprietary_api` covers a vendor endpoint whose weights are not
 * distributed at all, where the only identity available is the vendor's own
 * string.
 */
export type ModelOrigin = 'hub' | 'proprietary_api' | 'local_artifact' | 'unknown';

export interface ModelIdentity {
  /**
   * The family or repository the weights belong to, e.g. "Qwen/Qwen3-8B" or
   * "openai/gpt-frontier". Namespaced by its origin, never a bare name.
   */
  repository: string;
  origin: ModelOrigin;

  /**
   * The exact revision. A branch or tag is NOT a revision — it moves.
   *
   * For a hub model this is the commit SHA. For a proprietary API it is the
   * dated snapshot id the vendor returned, which is why it is recorded from
   * the response rather than from configuration.
   */
  revision?: string;
  /** Commit SHA where the origin exposes one. Distinct from a dated alias. */
  commitSha?: string;
  /**
   * A digest over the weight files, where the origin publishes one.
   *
   * Absent for every proprietary API, which is a real limitation and is
   * reported as such rather than substituted with a hash of the model name.
   */
  weightsDigest?: string;

  /** Architecture family, as declared by the origin. Never inferred. */
  architecture?: string;
  parameterCount?: number;
  /** Modalities the WEIGHTS support, before any serving restriction. */
  modalities?: readonly ('text' | 'vision' | 'audio' | 'video')[];

  /** Tokenizer, which can be revised independently of the weights. */
  tokenizerRepository?: string;
  tokenizerRevision?: string;

  /** The vendor's or publisher's own version string, verbatim. */
  publisherVersion?: string;
}

/**
 * Content address for a model.
 *
 * Two models with the same address are the same weights. The revision and
 * digest dominate: a repository name alone is not identity, because a
 * repository is mutable.
 */
export function modelDigest(m: ModelIdentity): string {
  const h = createHash('sha256');
  h.update('model-identity:v1\n');
  h.update(`${m.origin}\n${m.repository}\n`);
  // Every pinning field participates. A model with no revision hashes
  // differently from the same repository at a known revision, which is
  // correct: they are not the same claim.
  h.update(`rev:${m.revision ?? ''}\n`);
  h.update(`sha:${m.commitSha ?? ''}\n`);
  h.update(`weights:${m.weightsDigest ?? ''}\n`);
  h.update(`tok:${m.tokenizerRepository ?? ''}@${m.tokenizerRevision ?? ''}\n`);
  return `sha256:${h.digest('hex')}`;
}

/**
 * How firmly a model is pinned.
 *
 * The reason this is a first-class answer rather than a boolean: a result
 * against an unpinned model is not worthless, it is just not reproducible, and
 * a leaderboard has to be able to say which it is holding.
 */
export type PinningStrength = 'exact' | 'revision' | 'alias' | 'unpinned';

export function pinningStrength(m: ModelIdentity): {
  strength: PinningStrength;
  reason: string;
} {
  if (m.weightsDigest) {
    return {
      strength: 'exact',
      reason: 'Pinned to a weights digest. The exact bytes evaluated can be re-fetched.',
    };
  }
  if (m.commitSha) {
    return {
      strength: 'revision',
      reason: 'Pinned to a commit. The repository could be deleted, but not silently changed.',
    };
  }
  if (m.revision) {
    return {
      strength: 'alias',
      reason:
        'Pinned to a provider-reported revision. Reproducible only while the provider keeps ' +
        'serving that snapshot.',
    };
  }
  return {
    strength: 'unpinned',
    reason:
      'No revision was recorded. A later run may evaluate different weights under the same ' +
      'name, and the two results cannot be distinguished.',
  };
}

// ---------------------------------------------------------- deployment

/**
 * The serving stack. A value, never a branch — see the neutrality note above.
 */
export type InferenceEngine =
  | 'vllm'
  | 'sglang'
  | 'tgi'
  | 'ollama'
  | 'llamacpp'
  | 'lmstudio'
  | 'nim'
  | 'tensorrt-llm'
  | 'transformers'
  | 'vendor_managed'
  | 'unknown';

export type NumericPrecision =
  | 'fp32'
  | 'fp16'
  | 'bf16'
  | 'fp8'
  | 'int8'
  | 'int4'
  | 'mixed'
  | 'unknown';

export interface RuntimeProvenance {
  engine: InferenceEngine;
  /** The engine's own version string. */
  engineVersion?: string;
  /**
   * Container digest, where the runtime ships as an image.
   *
   * This is the strongest reproducibility handle a runtime can offer, which is
   * why it is recorded separately from the version: a tag moves, a digest does
   * not.
   */
  containerDigest?: string;
  precision?: NumericPrecision;
  /** Quantisation scheme as the runtime names it, e.g. "awq", "gptq", "q4_K_M". */
  quantization?: string;
  /** Serving context length, which is often below the model's own maximum. */
  maxContextLength?: number;
  /** Tensor/pipeline parallelism, which changes throughput and can change output. */
  tensorParallelism?: number;
}

/**
 * Hardware, vendor-neutral.
 *
 * `vendor` is an open string rather than an enum: a closed list would need
 * editing every time an accelerator ships, and an unrecognised accelerator
 * would then be unrepresentable. The named constants below are conveniences,
 * not a constraint.
 */
export interface AcceleratorProvenance {
  /** "nvidia", "amd", "google", "aws", "intel", "apple", "cpu", … */
  vendor: string;
  /** The accelerator model, e.g. "H100", "MI300X", "TPU v5e", "Trainium2". */
  model?: string;
  /** How many took part. */
  count?: number;
  /** Per-accelerator memory. */
  memoryGb?: number;
  /**
   * Driver and toolkit versions, keyed by name.
   *
   * A map rather than `cudaVersion`/`rocmVersion` fields, because naming them
   * individually is how a schema acquires a vendor bias. CUDA is a key here in
   * exactly the way ROCm is.
   */
  toolkitVersions?: Readonly<Record<string, string>>;
  /** Host machine label, where the operator supplies one. */
  hostLabel?: string;
}

export const ACCELERATOR_VENDORS = {
  NVIDIA: 'nvidia',
  AMD: 'amd',
  GOOGLE: 'google',
  AWS: 'aws',
  INTEL: 'intel',
  APPLE: 'apple',
  CPU: 'cpu',
} as const;

export interface DeploymentIdentity {
  /** Adapter id that reached this deployment, e.g. "vllm", "openai". */
  provider: string;
  /**
   * The identifier the provider was actually asked for.
   *
   * Distinct from the model's repository: a served deployment may expose
   * weights under a different name than the hub does.
   */
  servedModelId: string;
  runtime: RuntimeProvenance;
  accelerator?: AcceleratorProvenance;
  /**
   * The endpoint, for self-hosted and compatible deployments.
   *
   * Part of identity because the operator chose the machine. Omitted for a
   * vendor-managed API, where the vendor owns the deployment and the URL adds
   * nothing an auditor can use.
   */
  endpoint?: string;
}

export function deploymentDigest(d: DeploymentIdentity): string {
  const h = createHash('sha256');
  h.update('deployment-identity:v1\n');
  h.update(`${d.provider}\n${d.servedModelId}\n`);
  h.update(
    `engine:${d.runtime.engine}@${d.runtime.engineVersion ?? ''}\n` +
      `container:${d.runtime.containerDigest ?? ''}\n` +
      `precision:${d.runtime.precision ?? ''}\n` +
      `quant:${d.runtime.quantization ?? ''}\n` +
      `tp:${d.runtime.tensorParallelism ?? ''}\n`,
  );
  const a = d.accelerator;
  h.update(
    `hw:${a?.vendor ?? ''}/${a?.model ?? ''}x${a?.count ?? ''}\n` +
      `toolkits:${a?.toolkitVersions ? canonicalKeyValues(a.toolkitVersions) : ''}\n`,
  );
  h.update(`endpoint:${d.endpoint ?? ''}\n`);
  return `sha256:${h.digest('hex')}`;
}

/** Stable ordering, so key insertion order cannot change a digest. */
function canonicalKeyValues(rec: Readonly<Record<string, string>>): string {
  return Object.keys(rec)
    .sort()
    .map((k) => `${k}=${rec[k]}`)
    .join(',');
}

// ---------------------------------------------------------- the pair

/**
 * A model as actually evaluated: which weights, served how, on what.
 *
 * Every result attaches to one of these. `executionDigest` binds both halves
 * so a single value identifies the complete execution configuration.
 */
export interface EvaluatedModel {
  model: ModelIdentity;
  deployment: DeploymentIdentity;
}

export function executionDigest(e: EvaluatedModel): string {
  const h = createHash('sha256');
  h.update('execution:v1\n');
  h.update(`${modelDigest(e.model)}\n${deploymentDigest(e.deployment)}\n`);
  return `sha256:${h.digest('hex')}`;
}

/**
 * Whether two results may be attributed to the same model.
 *
 * True when the weights match, whatever the serving stack. This is what makes
 * "Qwen on vLLM vs Qwen on NIM" a meaningful comparison rather than two
 * unrelated rows.
 */
export function isSameModel(a: EvaluatedModel, b: EvaluatedModel): boolean {
  return modelDigest(a.model) === modelDigest(b.model);
}

/** True when the entire execution configuration matches. */
export function isSameExecution(a: EvaluatedModel, b: EvaluatedModel): boolean {
  return executionDigest(a) === executionDigest(b);
}

/**
 * What differs between two executions.
 *
 * Returned as a list rather than a boolean because the UI has to explain WHY
 * two rows are not comparable. "Not apples-to-apples" with no reason trains
 * people to ignore the warning.
 */
export interface ExecutionDifference {
  dimension: 'model' | 'runtime' | 'hardware' | 'endpoint' | 'precision' | 'quantization';
  detail: string;
}

export function diffExecutions(a: EvaluatedModel, b: EvaluatedModel): ExecutionDifference[] {
  const out: ExecutionDifference[] = [];

  if (modelDigest(a.model) !== modelDigest(b.model)) {
    out.push({
      dimension: 'model',
      detail:
        `different weights: ${describeModel(a.model)} vs ${describeModel(b.model)}`,
    });
  }
  if (a.deployment.runtime.engine !== b.deployment.runtime.engine) {
    out.push({
      dimension: 'runtime',
      detail: `${a.deployment.runtime.engine} vs ${b.deployment.runtime.engine}`,
    });
  }
  if (a.deployment.runtime.precision !== b.deployment.runtime.precision) {
    out.push({
      dimension: 'precision',
      detail: `${a.deployment.runtime.precision ?? 'unknown'} vs ${b.deployment.runtime.precision ?? 'unknown'}`,
    });
  }
  if (a.deployment.runtime.quantization !== b.deployment.runtime.quantization) {
    out.push({
      dimension: 'quantization',
      detail: `${a.deployment.runtime.quantization ?? 'none'} vs ${b.deployment.runtime.quantization ?? 'none'}`,
    });
  }
  const ha = a.deployment.accelerator;
  const hb = b.deployment.accelerator;
  if (`${ha?.vendor}/${ha?.model}` !== `${hb?.vendor}/${hb?.model}`) {
    out.push({
      dimension: 'hardware',
      detail: `${describeAccelerator(ha)} vs ${describeAccelerator(hb)}`,
    });
  }
  if (a.deployment.endpoint !== b.deployment.endpoint) {
    out.push({ dimension: 'endpoint', detail: 'served from different endpoints' });
  }
  return out;
}

export function describeModel(m: ModelIdentity): string {
  const rev = m.commitSha ?? m.revision;
  return rev ? `${m.repository}@${rev.slice(0, 12)}` : m.repository;
}

export function describeAccelerator(a?: AcceleratorProvenance): string {
  if (!a) return 'unspecified hardware';
  const count = a.count && a.count > 1 ? `${a.count}x ` : '';
  return `${count}${a.vendor}${a.model ? ` ${a.model}` : ''}`;
}

export function describeDeployment(d: DeploymentIdentity): string {
  return `${d.runtime.engine} on ${describeAccelerator(d.accelerator)}`;
}
