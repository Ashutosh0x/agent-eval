/**
 * Model memory estimation.
 *
 * Everything here is an estimate and is labelled as one in the type, not just
 * in a comment. A parameter count does not determine memory use: the runtime,
 * the KV cache layout, paged attention, CUDA graph capture and the allocator's
 * fragmentation all move the real number, and a platform that reported a
 * confident figure would be inviting an out-of-memory failure halfway through
 * an evaluation.
 *
 * The estimates are deliberately conservative — they overestimate. Refusing a
 * run that would have fit is recoverable; accepting one that does not fit
 * wastes the run and, worse, produces a failed evaluation whose cause looks
 * like the model rather than the scheduler.
 */

export type Precision = 'fp32' | 'fp16' | 'bf16' | 'fp8' | 'nvfp4' | 'mxfp4' | 'int8' | 'int4';

/** Bytes per parameter for each precision. */
const BYTES_PER_PARAM: Record<Precision, number> = {
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8: 1,
  int8: 1,
  // FP4 formats are four bits of mantissa plus block scales; the scales are
  // real memory, so this is above 0.5 rather than exactly 0.5.
  nvfp4: 0.6,
  mxfp4: 0.6,
  int4: 0.6,
};

export interface MemoryEstimateInput {
  /** Parameters in billions, e.g. 8 for an 8B model. */
  parametersB: number;
  precision: Precision;
  /** Maximum context the runtime will be configured for. */
  contextLength: number;
  /** Concurrent sequences the runtime keeps KV cache for. */
  concurrency?: number;
  /** Transformer layers. Estimated from parameter count when not supplied. */
  layers?: number;
  /** Model hidden size. Estimated from parameter count when not supplied. */
  hiddenSize?: number;
  /** KV heads, where grouped-query attention reduces cache size substantially. */
  kvHeads?: number;
  attentionHeads?: number;
}

export interface MemoryEstimate {
  /** Always true. Present in the payload so a consumer cannot forget. */
  isEstimate: true;
  weightsBytes: number;
  kvCacheBytes: number;
  overheadBytes: number;
  totalBytes: number;
  /** What was assumed rather than given, so the number can be argued with. */
  assumptions: string[];
  method: string;
}

/**
 * Rough geometry for a decoder-only transformer at a given size.
 *
 * These come from the shapes common open-weight model families actually use.
 * They are used only when the caller does not supply real values, and every
 * use is recorded in `assumptions`.
 */
function inferGeometry(parametersB: number): { layers: number; hiddenSize: number; kvHeads: number } {
  if (parametersB <= 2) return { layers: 24, hiddenSize: 2048, kvHeads: 4 };
  if (parametersB <= 5) return { layers: 32, hiddenSize: 3072, kvHeads: 8 };
  if (parametersB <= 10) return { layers: 32, hiddenSize: 4096, kvHeads: 8 };
  if (parametersB <= 20) return { layers: 48, hiddenSize: 6144, kvHeads: 8 };
  if (parametersB <= 40) return { layers: 60, hiddenSize: 8192, kvHeads: 8 };
  if (parametersB <= 80) return { layers: 80, hiddenSize: 8192, kvHeads: 8 };
  if (parametersB <= 150) return { layers: 96, hiddenSize: 12288, kvHeads: 8 };
  return { layers: 126, hiddenSize: 16384, kvHeads: 8 };
}

const GIB = 1024 ** 3;

export function estimateModelMemory(input: MemoryEstimateInput): MemoryEstimate {
  const assumptions: string[] = [];
  const geometry = inferGeometry(input.parametersB);

  const layers = input.layers ?? geometry.layers;
  const hiddenSize = input.hiddenSize ?? geometry.hiddenSize;
  const kvHeads = input.kvHeads ?? geometry.kvHeads;
  const attentionHeads = input.attentionHeads ?? Math.max(kvHeads, hiddenSize / 128);
  const concurrency = input.concurrency ?? 1;

  if (input.layers === undefined) assumptions.push(`layers assumed ${layers} from parameter count`);
  if (input.hiddenSize === undefined) {
    assumptions.push(`hidden size assumed ${hiddenSize} from parameter count`);
  }
  if (input.kvHeads === undefined) {
    assumptions.push(`KV heads assumed ${kvHeads} (grouped-query attention)`);
  }
  if (input.concurrency === undefined) assumptions.push('concurrency assumed 1 sequence');

  const weightsBytes = input.parametersB * 1e9 * BYTES_PER_PARAM[input.precision];

  // KV cache: 2 (K and V) x layers x kvHeads x headDim x context x sequences,
  // held at 16-bit. Runtimes can quantise it, which would make this an
  // overestimate — the direction this module errs in on purpose.
  const headDim = hiddenSize / Math.max(attentionHeads, 1);
  const kvCacheBytes = 2 * layers * kvHeads * headDim * input.contextLength * concurrency * 2;
  assumptions.push('KV cache assumed 16-bit and unquantised');

  // Activations, allocator fragmentation, CUDA context, graph capture and the
  // framework itself. A proportion plus a floor, because the fixed costs
  // dominate for small models and the proportional ones for large.
  const overheadBytes = Math.max(1.5 * GIB, 0.12 * (weightsBytes + kvCacheBytes));
  assumptions.push('runtime overhead assumed max(1.5 GiB, 12% of weights + KV cache)');

  return {
    isEstimate: true,
    weightsBytes: Math.round(weightsBytes),
    kvCacheBytes: Math.round(kvCacheBytes),
    overheadBytes: Math.round(overheadBytes),
    totalBytes: Math.round(weightsBytes + kvCacheBytes + overheadBytes),
    assumptions,
    method:
      'weights = parameters x bytes-per-parameter; KV cache = 2 x layers x kv_heads x head_dim x ' +
      'context x sequences x 2 bytes; plus runtime overhead. Conservative by design.',
  };
}

/** Why a run cannot proceed. Typed so callers can respond to the specific cause. */
export type ResourceRefusal =
  | { code: 'MODEL_MEMORY_REQUIREMENT_EXCEEDED'; detail: string; requiredBytes: number; availableBytes: number }
  | { code: 'GPU_UNAVAILABLE'; detail: string }
  | { code: 'RUNTIME_UNAVAILABLE'; detail: string }
  | { code: 'ARCHITECTURE_INCOMPATIBLE'; detail: string };

export interface ResourceDecision {
  allowed: boolean;
  refusal?: ResourceRefusal;
  estimate?: MemoryEstimate;
  /** Headroom left over if the run proceeds, as a fraction of total memory. */
  headroomFraction?: number;
}

/**
 * Decide whether a model fits.
 *
 * `availableBytes` should be the memory the model may actually use, which on a
 * unified-memory system is not the whole machine: the OS, the dashboard and
 * anything else resident are sharing it. The caller supplies the budget; this
 * function does not invent one.
 */
export function checkModelFits(
  estimate: MemoryEstimate,
  availableBytes: number,
  reserveFraction = 0.1,
): ResourceDecision {
  const usable = availableBytes * (1 - reserveFraction);
  if (estimate.totalBytes > usable) {
    return {
      allowed: false,
      estimate,
      refusal: {
        code: 'MODEL_MEMORY_REQUIREMENT_EXCEEDED',
        detail:
          `Estimated ${formatBytes(estimate.totalBytes)} required, ` +
          `${formatBytes(usable)} usable after a ${Math.round(reserveFraction * 100)}% reserve. ` +
          'This is a conservative estimate, not a measurement — see assumptions.',
        requiredBytes: estimate.totalBytes,
        availableBytes: Math.round(usable),
      },
    };
  }
  return {
    allowed: true,
    estimate,
    headroomFraction: (usable - estimate.totalBytes) / availableBytes,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}
