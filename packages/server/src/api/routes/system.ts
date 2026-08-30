/**
 * System and compute routes.
 *
 * These report what the machine actually is. Nothing here has a fallback
 * value: where a probe cannot answer, the response carries the probe's own
 * `unavailable` or `unknown` with the reason, and the dashboard renders that
 * rather than a zero. A GPU panel showing "0%" because nvidia-smi is missing
 * is worse than one showing "unavailable", because the first looks like a
 * measurement.
 *
 * Capabilities are cached briefly. They are the answer to "what is this
 * machine", which does not change between two requests a second apart, and
 * every call spawns several subprocesses.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  detectCapabilities,
  probeGpuTelemetry,
  type SystemCapabilities,
} from '../../system/capabilities.js';
import { estimateModelMemory, type Precision } from '../../system/memory.js';
import { RUNTIME_DESCRIPTORS, describeRuntime } from '../../providers/local-runtimes.js';
import { providerRegistry, resolveConfig } from '../../providers/registry.js';
import { problem } from '../../schemas/index.js';

export interface SystemRouteOptions {
  requireScope: (req: FastifyRequest, scope: string) => void;
  /** Overridable so tests do not shell out. */
  detect?: () => Promise<SystemCapabilities>;
}

/** Capabilities change on reboot, not per request. */
const CACHE_MS = 30_000;

export function registerSystemRoutes(app: FastifyInstance, options: SystemRouteOptions): void {
  const { requireScope } = options;
  const detect = options.detect ?? detectCapabilities;

  let cached: { at: number; value: SystemCapabilities } | null = null;

  async function capabilities(): Promise<SystemCapabilities> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const value = await detect();
    cached = { at: Date.now(), value };
    return value;
  }

  /**
   * What this machine is and what it can run.
   *
   * Note there is no `deploymentTarget: 'dgx-spark'` unless the GPU actually
   * identified as a GB10 part on arm64 Linux. The evidence for the verdict is
   * returned alongside it so the answer can be checked rather than believed.
   */
  app.get('/v1/system/capabilities', async (req) => {
    requireScope(req, 'runs:read');
    return capabilities();
  });

  /** Live telemetry. Polled, so kept out of the cached capability payload. */
  app.get('/v1/system/gpu', async (req) => {
    requireScope(req, 'runs:read');
    const [caps, telemetry] = await Promise.all([capabilities(), probeGpuTelemetry()]);
    return {
      devices: caps.gpu,
      telemetry,
      // Stated so a consumer cannot mistake a cached reading for a live one.
      sampledAt: new Date().toISOString(),
    };
  });

  /**
   * Component health.
   *
   * Deliberately not "ok because the process is running". Each component is
   * probed, and a component that is absent reports absent — Docker not being
   * installed is a fact about the deployment, not a server fault, so the
   * response is 200 with a degraded body rather than a 503.
   */
  app.get('/v1/system/health', async (req) => {
    requireScope(req, 'runs:read');
    const caps = await capabilities();

    const components = {
      api: { status: 'ok' as const, detail: 'this request was served' },
      gpu: describeProbe(caps.gpu, (gpus) => `${gpus.length} device(s): ${gpus.map((g) => g.name).join(', ')}`),
      cuda: describeProbe(caps.cuda, (v) => v),
      driver: describeProbe(caps.driver, (v) => v),
      docker: describeProbe(caps.docker, (v) => `server ${v}`),
      nvidiaContainerRuntime: describeProbe(caps.nvidiaContainerRuntime, () => 'runtime "nvidia" is registered with Docker'),
      os: describeProbe(caps.os, (v) => v),
    };

    const degraded = Object.values(components).filter((c) => c.status !== 'ok').length;

    return {
      // "healthy" would overstate it: this reports which components answered.
      summary: degraded === 0 ? 'all components responded' : `${degraded} component(s) unavailable or unknown`,
      deploymentTarget: caps.dgxSpark.target,
      dgxSpark: caps.dgxSpark.detected,
      components,
      checkedAt: new Date().toISOString(),
    };
  });

  /**
   * Inference runtimes, with a real connection test for each.
   *
   * `configured` and `reachable` are separate fields because they are separate
   * claims. A base URL in the environment says somebody intended a runtime to
   * exist; only the request says it does.
   */
  app.get('/v1/system/runtimes', async (req) => {
    requireScope(req, 'runs:read');
    const caps = await capabilities();

    const items = await Promise.all(
      RUNTIME_DESCRIPTORS.map(async (descriptor) => {
        const config = resolveConfig(descriptor.id);
        const configured = Boolean(config.baseUrl);

        // Always ask the adapter, even with nothing configured. Several
        // runtimes have a sensible default endpoint, and reporting them as
        // "not configured" while they were in fact answering on that default
        // was wrong in the other direction: it understated the system. The
        // adapter returns not_configured itself when it genuinely has no
        // address to try.
        const connection = providerRegistry.has(descriptor.id)
          ? await providerRegistry.get(descriptor.id).testConnection(config)
          : { status: 'unavailable' as const, detail: 'No adapter registered for this runtime.' };

        return {
          ...descriptor,
          // "configured" means an operator set an endpoint explicitly. It is
          // reported separately from `connection` because a runtime answering
          // on its default is a different fact from one somebody chose.
          configured,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          connection,
          // Repeated per runtime so a caller reading one entry has the whole
          // picture without cross-referencing the capabilities endpoint.
          platformNote: caps.dgxSpark.detected
            ? descriptor.dgxSpark.note
            : 'This host is not a recognised DGX Spark; the DGX Spark note is informational only.',
        };
      }),
    );

    return { items, host: { target: caps.dgxSpark.target, isArm64: caps.isArm64 } };
  });

  /**
   * Estimate whether a model fits, before anything is started.
   *
   * A GET with query parameters rather than a POST: it computes and stores
   * nothing. The response is explicitly an estimate and carries its own
   * assumptions so the number can be argued with rather than trusted.
   */
  app.get('/v1/system/memory', async (req, reply) => {
    requireScope(req, 'runs:read');
    const q = req.query as Record<string, string | undefined>;
    const caps = await capabilities();

    if (!q.parametersB) {
      return {
        memory: {
          totalBytes: caps.memory.totalBytes,
          freeBytes: caps.memory.freeBytes,
          unified: caps.memory.unified,
        },
        note: 'Pass parametersB, precision and contextLength to estimate a model footprint.',
      };
    }

    const parametersB = Number(q.parametersB);
    const contextLength = Number(q.contextLength ?? 8192);
    const precision = (q.precision ?? 'bf16') as Precision;

    if (!Number.isFinite(parametersB) || parametersB <= 0) {
      return reply
        .status(400)
        .type('application/problem+json')
        .send(problem('invalid-parameter', 'parametersB must be a positive number', 400, q.parametersB, 'parametersB'));
    }

    const estimate = estimateModelMemory({
      parametersB,
      precision,
      contextLength: Number.isFinite(contextLength) ? contextLength : 8192,
      ...(q.concurrency ? { concurrency: Number(q.concurrency) } : {}),
    });

    return {
      estimate,
      memory: { totalBytes: caps.memory.totalBytes, freeBytes: caps.memory.freeBytes },
    };
  });

  /** One runtime's descriptor, for the setup flow. */
  app.get<{ Params: { id: string } }>('/v1/system/runtimes/:id', async (req, reply) => {
    requireScope(req, 'runs:read');
    const descriptor = describeRuntime(req.params.id);
    if (!descriptor) {
      return reply
        .status(404)
        .type('application/problem+json')
        .send(problem('not-found', 'Unknown runtime', 404, req.params.id));
    }
    const config = resolveConfig(descriptor.id);
    return { ...descriptor, configured: Boolean(config.baseUrl) };
  });
}

type ComponentStatus = { status: 'ok' | 'unavailable' | 'unknown'; detail: string };

/** Turn a probe into a health component without inventing a verdict. */
function describeProbe<T>(
  probe: { status: 'ok'; value: T } | { status: 'unavailable' | 'unknown'; reason: string },
  describe: (value: T) => string,
): ComponentStatus {
  if (probe.status === 'ok') return { status: 'ok', detail: describe(probe.value) };
  return { status: probe.status, detail: probe.reason };
}
