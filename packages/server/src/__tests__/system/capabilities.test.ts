/**
 * System detection tests.
 *
 * The assertions that matter here are about restraint. This module reports
 * hardware into evidence, so the failure that costs something is not "missed a
 * GPU" — it is "claimed a GPU, or a memory size, or a DGX Spark, that was not
 * there". Most of these tests check that a fact is *absent* when it was not
 * measured.
 *
 * Detection itself runs against whatever machine the suite is on, so the tests
 * assert the shape and the reasoning rather than a specific answer.
 */

import { describe, expect, it } from 'vitest';
import { arch, platform } from 'node:os';
import { detectCapabilities, toEnvironmentRecord } from '../../system/capabilities.js';
import { firstLine, ok, unavailable, unknown, valueOf } from '../../system/probe.js';
import { checkModelFits, estimateModelMemory, formatBytes } from '../../system/memory.js';

describe('probes report absence rather than a default', () => {
  it('distinguishes unavailable from unknown', () => {
    // "not installed" and "installed but answered strangely" send an operator
    // to different places, so they are different states.
    expect(unavailable('nvidia-smi is not installed').status).toBe('unavailable');
    expect(unknown('output not recognised').status).toBe('unknown');
    expect(valueOf(unavailable('x'))).toBeUndefined();
    expect(valueOf(ok(42))).toBe(42);
  });

  it('reads the first meaningful line', () => {
    expect(firstLine('\n\n  13.0.2  \nsecond')).toBe('13.0.2');
    expect(firstLine('   \n  ')).toBeUndefined();
  });
});

describe('capability detection', () => {
  it('reports the architecture it is actually running on', async () => {
    const caps = await detectCapabilities();
    expect(caps.architecture).toBe(arch());
    expect(caps.platform).toBe(platform());
    expect(caps.isArm64).toBe(arch() === 'arm64');
  });

  it('measures memory rather than assuming a machine size', async () => {
    const caps = await detectCapabilities();
    // Never 128 GiB because a specification sheet says so.
    expect(caps.memory.totalBytes).toBeGreaterThan(0);
    expect(caps.cpu.cores).toBeGreaterThan(0);
  });

  it('gives every unmeasured fact a reason', async () => {
    const caps = await detectCapabilities();
    for (const probe of [caps.gpu, caps.cuda, caps.driver, caps.docker, caps.os]) {
      if (probe.status !== 'ok') {
        expect(probe.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('explains its DGX Spark verdict either way', async () => {
    const caps = await detectCapabilities();
    expect(typeof caps.dgxSpark.detected).toBe('boolean');
    // A verdict with no evidence is an assertion; this one must show working.
    expect(caps.dgxSpark.evidence.length).toBeGreaterThan(0);
  });

  it('does not claim DGX Spark on a machine that is not one', async () => {
    const caps = await detectCapabilities();
    // The suite does not run on a DGX Spark. If this ever fails on real
    // hardware that is a genuine result, not a broken test.
    if (arch() !== 'arm64' || platform() !== 'linux') {
      expect(caps.dgxSpark.detected).toBe(false);
      expect(caps.dgxSpark.target).not.toBe('dgx-spark');
    }
  });

  it('only asserts unified memory on a recognised system', async () => {
    const caps = await detectCapabilities();
    if (!caps.dgxSpark.detected) {
      // Not "false" — unknown. Claiming non-unified would be a claim too.
      expect(caps.memory.unified.status).toBe('unknown');
    }
  });
});

describe('the record that reaches evidence', () => {
  it('omits facts that were not measured', async () => {
    const caps = await detectCapabilities();
    const record = toEnvironmentRecord(caps);

    // Whatever this machine is, the record must never invent these.
    if (caps.gpu.status !== 'ok') {
      expect(record.gpuName).toBeUndefined();
      expect(record.gpuCount).toBeUndefined();
    }
    if (caps.cuda.status !== 'ok') expect(record.cudaVersion).toBeUndefined();
    if (caps.driver.status !== 'ok') expect(record.driverVersion).toBeUndefined();
  });

  it('carries no telemetry, so two runs of one configuration match', async () => {
    const record = toEnvironmentRecord(await detectCapabilities());
    const keys = Object.keys(record);
    // Free memory, utilisation and timestamps would differ between two
    // identical runs and would make the record useless for comparison.
    expect(keys).not.toContain('freeBytes');
    expect(keys).not.toContain('detectedAt');
    expect(keys).not.toContain('utilizationPercent');
  });

  it('is stable across calls on an unchanged machine', async () => {
    const a = toEnvironmentRecord(await detectCapabilities());
    const b = toEnvironmentRecord(await detectCapabilities());
    expect(a).toEqual(b);
  });
});

describe('model memory estimation', () => {
  it('marks itself an estimate in the payload, not just the docs', () => {
    const e = estimateModelMemory({ parametersB: 8, precision: 'bf16', contextLength: 8192 });
    expect(e.isEstimate).toBe(true);
    expect(e.assumptions.length).toBeGreaterThan(0);
    expect(e.method).toMatch(/conservative/i);
  });

  it('scales with parameters and precision', () => {
    const bf16 = estimateModelMemory({ parametersB: 8, precision: 'bf16', contextLength: 4096 });
    const fp4 = estimateModelMemory({ parametersB: 8, precision: 'nvfp4', contextLength: 4096 });
    const bigger = estimateModelMemory({ parametersB: 70, precision: 'bf16', contextLength: 4096 });

    expect(fp4.weightsBytes).toBeLessThan(bf16.weightsBytes);
    expect(bigger.weightsBytes).toBeGreaterThan(bf16.weightsBytes);
    // A 4-bit format is not exactly half of 8-bit: block scales are real bytes.
    expect(fp4.weightsBytes).toBeGreaterThan(8e9 * 0.5);
  });

  it('grows the KV cache with context and concurrency', () => {
    const short = estimateModelMemory({ parametersB: 8, precision: 'bf16', contextLength: 4096 });
    const long = estimateModelMemory({ parametersB: 8, precision: 'bf16', contextLength: 131072 });
    const busy = estimateModelMemory({
      parametersB: 8,
      precision: 'bf16',
      contextLength: 4096,
      concurrency: 32,
    });
    expect(long.kvCacheBytes).toBeGreaterThan(short.kvCacheBytes * 10);
    expect(busy.kvCacheBytes).toBe(short.kvCacheBytes * 32);
  });

  it('records which geometry it had to assume', () => {
    const assumed = estimateModelMemory({ parametersB: 8, precision: 'bf16', contextLength: 4096 });
    expect(assumed.assumptions.join(' ')).toMatch(/layers assumed/);

    const given = estimateModelMemory({
      parametersB: 8,
      precision: 'bf16',
      contextLength: 4096,
      layers: 32,
      hiddenSize: 4096,
      kvHeads: 8,
      concurrency: 1,
    });
    expect(given.assumptions.join(' ')).not.toMatch(/layers assumed/);
  });

  it('refuses a model that does not fit, with the numbers', () => {
    const huge = estimateModelMemory({ parametersB: 405, precision: 'bf16', contextLength: 131072 });
    const decision = checkModelFits(huge, 128 * 1024 ** 3);

    expect(decision.allowed).toBe(false);
    expect(decision.refusal?.code).toBe('MODEL_MEMORY_REQUIREMENT_EXCEEDED');
    // The refusal must not read as a server fault, and must say it is an estimate.
    expect(decision.refusal?.detail).toMatch(/estimate/i);
    expect(decision.refusal).toHaveProperty('requiredBytes');
  });

  it('allows one that fits, keeping a reserve', () => {
    const small = estimateModelMemory({ parametersB: 8, precision: 'nvfp4', contextLength: 8192 });
    const decision = checkModelFits(small, 128 * 1024 ** 3);
    expect(decision.allowed).toBe(true);
    expect(decision.headroomFraction).toBeGreaterThan(0);
  });

  it('holds back a reserve rather than filling the machine', () => {
    const estimate = estimateModelMemory({ parametersB: 8, precision: 'bf16', contextLength: 4096 });
    // Exactly the estimate as budget: refused, because the reserve is not
    // available to the model.
    expect(checkModelFits(estimate, estimate.totalBytes).allowed).toBe(false);
  });

  it('formats sizes a person can read', () => {
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GiB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MiB');
  });
});
