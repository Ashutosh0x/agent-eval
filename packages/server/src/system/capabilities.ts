/**
 * System capability detection.
 *
 * What this module answers: what machine is this, what GPU does it have, what
 * can actually run here. Every value is measured from the running system —
 * there is no table of DGX Spark specifications in this file, and putting one
 * here would defeat the purpose. A deployment that reports 128 GB because the
 * code knows DGX Spark has 128 GB has reported nothing.
 *
 * DGX Spark identification is deliberately conservative. The published
 * specification (Grace Blackwell GB10, 20-core Arm, 128 GB LPDDR5x unified,
 * 273 GB/s, ConnectX-7) is used only to *recognise* a machine, never to fill
 * in values the machine did not report. A confident "this is a DGX Spark" on
 * hardware that merely looks similar would put a false claim into evidence.
 *
 * Sources for the identification heuristics, current as of August 2026:
 *   https://docs.nvidia.com/dgx/dgx-spark/hardware.html
 *   https://docs.nvidia.com/dgx/dgx-spark-porting-guide/porting/software-requirements.html
 */

import { arch, cpus, platform, totalmem, freemem, release } from 'node:os';
import { readFile } from 'node:fs/promises';
import {
  firstLine,
  isError,
  ok,
  probeCommand,
  run,
  unavailable,
  unknown,
  valueOf,
  type Probe,
} from './probe.js';

export type DeploymentTarget = 'local' | 'docker' | 'dgx-spark' | 'server' | 'unknown';

export interface GpuInfo {
  name: string;
  /** From nvidia-smi compute_cap, e.g. "12.1". Absent on older drivers. */
  computeCapability?: string;
  /** Reported by the driver. On a unified-memory part this is not separate RAM. */
  memoryTotalMiB?: number;
  driverVersion?: string;
}

export interface GpuTelemetry {
  utilizationPercent?: number;
  memoryUsedMiB?: number;
  temperatureCelsius?: number;
  powerDrawWatts?: number;
}

export interface SystemCapabilities {
  platform: string;
  architecture: string;
  /** True for arm64. DGX Spark is an Arm platform; x86-only images will not run. */
  isArm64: boolean;
  kernel: string;
  cpu: { model?: string; cores: number };
  memory: {
    totalBytes: number;
    freeBytes: number;
    /**
     * Whether CPU and GPU share one physical pool. Asserted only when the GPU
     * is identified as a Grace Blackwell part; otherwise unknown, because
     * guessing changes how much memory a caller thinks a model may use.
     */
    unified: Probe<boolean>;
  };
  gpu: Probe<GpuInfo[]>;
  cuda: Probe<string>;
  driver: Probe<string>;
  docker: Probe<string>;
  /** Whether Docker exposes a runtime named "nvidia". */
  nvidiaContainerRuntime: Probe<boolean>;
  os: Probe<string>;
  /** True only when this is recognisably a DGX Spark, with the evidence why. */
  dgxSpark: { detected: boolean; evidence: string[]; target: DeploymentTarget };
  detectedAt: string;
}

// ------------------------------------------------------------------ GPU

/**
 * nvidia-smi in CSV mode. The field list is explicit so the parse does not
 * depend on column order in a human-readable table, which changes between
 * driver releases.
 */
async function probeGpus(): Promise<Probe<GpuInfo[]>> {
  const result = await run('nvidia-smi', [
    '--query-gpu=name,compute_cap,memory.total,driver_version',
    '--format=csv,noheader,nounits',
  ]);

  if (isError(result)) return unavailable(result.error);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    return unavailable(`nvidia-smi exited ${result.code}${detail ? `: ${detail}` : ''}`);
  }

  const gpus: GpuInfo[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length < 1 || !parts[0]) continue;
    const memory = Number(parts[2]);
    gpus.push({
      name: parts[0],
      ...(parts[1] && parts[1] !== '[N/A]' ? { computeCapability: parts[1] } : {}),
      ...(Number.isFinite(memory) ? { memoryTotalMiB: memory } : {}),
      ...(parts[3] && parts[3] !== '[N/A]' ? { driverVersion: parts[3] } : {}),
    });
  }

  if (gpus.length === 0) {
    // nvidia-smi ran and listed nothing. That is a real answer, and different
    // from nvidia-smi being absent.
    return unavailable('nvidia-smi reported no GPUs');
  }
  return ok(gpus);
}

/**
 * Live telemetry. Separate from the static capability probe because it is
 * polled, and because a missing metric here must render as "unavailable"
 * rather than zero — a 0% utilisation reading that actually means "we could
 * not ask" is the kind of number an operator makes decisions on.
 */
export async function probeGpuTelemetry(): Promise<Probe<GpuTelemetry[]>> {
  const result = await run('nvidia-smi', [
    '--query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ]);
  if (isError(result)) return unavailable(result.error);
  if (result.code !== 0) return unavailable(`nvidia-smi exited ${result.code}`);

  const rows: GpuTelemetry[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [util, used, temp, power] = trimmed.split(',').map((p) => p.trim());
    const num = (v: string | undefined) => {
      const n = Number(v);
      // "[N/A]" is common for power and temperature on integrated parts.
      return Number.isFinite(n) ? n : undefined;
    };
    rows.push({
      ...(num(util) !== undefined ? { utilizationPercent: num(util) } : {}),
      ...(num(used) !== undefined ? { memoryUsedMiB: num(used) } : {}),
      ...(num(temp) !== undefined ? { temperatureCelsius: num(temp) } : {}),
      ...(num(power) !== undefined ? { powerDrawWatts: num(power) } : {}),
    });
  }
  return rows.length > 0 ? ok(rows) : unavailable('nvidia-smi reported no GPUs');
}

// ------------------------------------------------------------------ software

async function probeCuda(): Promise<Probe<string>> {
  // nvcc is the toolkit; it is not always installed even where CUDA runs.
  const nvcc = await probeCommand('nvcc', ['--version'], (out) => {
    const match = out.match(/release ([0-9]+\.[0-9]+)/);
    return match?.[1];
  });
  if (nvcc.status === 'ok') return nvcc;

  // Fall back to the driver's reported CUDA version, which is the maximum the
  // driver supports rather than an installed toolkit — labelled as such.
  const smi = await probeCommand('nvidia-smi', [], (out) => {
    const match = out.match(/CUDA Version:\s*([0-9]+\.[0-9]+)/);
    return match?.[1] ? `${match[1]} (driver maximum; no nvcc found)` : undefined;
  });
  if (smi.status === 'ok') return smi;

  return unavailable('neither nvcc nor nvidia-smi reported a CUDA version');
}

async function probeDocker(): Promise<Probe<string>> {
  return probeCommand('docker', ['version', '--format', '{{.Server.Version}}'], firstLine);
}

/**
 * Whether Docker knows about a runtime named "nvidia".
 *
 * This is what the NVIDIA Container Toolkit registers, and its presence is the
 * difference between `--gpus all` working and failing. Checked through docker
 * info rather than by looking for a file, because the file existing does not
 * mean Docker was reconfigured to use it.
 */
async function probeNvidiaRuntime(): Promise<Probe<boolean>> {
  const result = await run('docker', ['info', '--format', '{{json .Runtimes}}']);
  if (isError(result)) return unavailable(result.error);
  if (result.code !== 0) return unavailable(`docker info exited ${result.code}`);
  try {
    const runtimes = JSON.parse(result.stdout.trim() || '{}') as Record<string, unknown>;
    const names = Object.keys(runtimes);
    return names.includes('nvidia')
      ? ok(true)
      : unavailable(`docker runtimes present: ${names.join(', ') || 'none'}`);
  } catch {
    return unknown('docker info returned output that could not be parsed as JSON');
  }
}

/** DGX OS advertises itself in /etc/dgx-release; otherwise fall back to os-release. */
async function probeOs(): Promise<Probe<string>> {
  for (const file of ['/etc/dgx-release', '/etc/os-release']) {
    try {
      const text = await readFile(file, 'utf8');
      const pretty = text.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1];
      const dgx = text.match(/DGX_PRETTY_NAME="?([^"\n]+)"?/)?.[1];
      const name = dgx ?? pretty ?? firstLine(text);
      if (name) return ok(name);
    } catch {
      // Absent on non-Linux and on minimal images; try the next candidate.
    }
  }
  return unavailable('no /etc/dgx-release or /etc/os-release');
}

async function probeKernel(): Promise<string> {
  const result = await run('uname', ['-r']);
  if (!isError(result) && result.code === 0) {
    const line = firstLine(result.stdout);
    if (line) return line;
  }
  return release();
}

// ------------------------------------------------------------------ identity

/**
 * Decide whether this is a DGX Spark, and say why.
 *
 * The evidence list is returned with the verdict so the answer is auditable
 * rather than magic. Identification requires the GPU to name a Grace Blackwell
 * GB10 part on an arm64 Linux host — the combination is specific, and neither
 * half alone is sufficient. A Blackwell datacentre GPU in an x86 server is not
 * a Spark, and an arm64 Linux box with no NVIDIA GPU certainly is not.
 */
function identifyDgxSpark(input: {
  isArm64: boolean;
  isLinux: boolean;
  gpus: GpuInfo[] | undefined;
  osName: string | undefined;
}): { detected: boolean; evidence: string[]; target: DeploymentTarget } {
  const evidence: string[] = [];

  const gpuNames = (input.gpus ?? []).map((g) => g.name).join(' ');
  const looksGb10 = /GB10|GB\s?10/i.test(gpuNames);
  const looksGraceBlackwell = /grace\s*blackwell/i.test(gpuNames);
  const osLooksDgx = /dgx/i.test(input.osName ?? '');

  if (input.isArm64) evidence.push('architecture is arm64');
  if (input.isLinux) evidence.push('platform is linux');
  if (looksGb10) evidence.push(`GPU name matches GB10: "${gpuNames}"`);
  else if (looksGraceBlackwell) evidence.push(`GPU name matches Grace Blackwell: "${gpuNames}"`);
  if (osLooksDgx) evidence.push(`OS identifies as DGX: "${input.osName}"`);

  const detected = input.isArm64 && input.isLinux && (looksGb10 || (looksGraceBlackwell && osLooksDgx));

  if (!detected) {
    if (!input.isArm64) evidence.push('not arm64, so not a DGX Spark');
    else if (!input.isLinux) evidence.push('not linux, so not a DGX Spark');
    else evidence.push('no GB10 or Grace Blackwell GPU reported');
  }

  const target: DeploymentTarget = detected
    ? 'dgx-spark'
    : input.isLinux
      ? 'server'
      : 'local';

  return { detected, evidence, target };
}

/** True when this process is inside a container, which changes what probes mean. */
export async function inContainer(): Promise<boolean> {
  try {
    await readFile('/.dockerenv');
    return true;
  } catch {
    // Not conclusive on its own; cgroup inspection covers the common runtimes.
  }
  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf8');
    return /docker|containerd|kubepods/.test(cgroup);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ entrypoint

export async function detectCapabilities(): Promise<SystemCapabilities> {
  const [gpu, cuda, docker, nvidiaRuntime, os, kernel, containerised] = await Promise.all([
    probeGpus(),
    probeCuda(),
    probeDocker(),
    probeNvidiaRuntime(),
    probeOs(),
    probeKernel(),
    inContainer(),
  ]);

  const architecture = arch();
  const isArm64 = architecture === 'arm64';
  const isLinux = platform() === 'linux';
  const gpus = valueOf(gpu);

  const identity = identifyDgxSpark({
    isArm64,
    isLinux,
    gpus,
    osName: valueOf(os),
  });

  // Driver version comes from the GPU rows; asking nvidia-smi twice for it
  // would be a second chance to disagree with itself.
  const driverVersion = gpus?.find((g) => g.driverVersion)?.driverVersion;

  const processors = cpus();

  return {
    platform: platform(),
    architecture,
    isArm64,
    kernel,
    cpu: {
      ...(processors[0]?.model ? { model: processors[0].model.trim() } : {}),
      cores: processors.length,
    },
    memory: {
      totalBytes: totalmem(),
      freeBytes: freemem(),
      // Only claimed where the GPU identifies as the unified-memory part. On
      // anything else the honest answer is that we do not know, because
      // saying "false" would be a claim too.
      unified: identity.detected
        ? ok(true)
        : unknown('unified memory is only asserted on a recognised GB10 system'),
    },
    gpu,
    cuda,
    driver: driverVersion ? ok(driverVersion) : unavailable('no driver version reported by nvidia-smi'),
    docker,
    nvidiaContainerRuntime: nvidiaRuntime,
    os,
    dgxSpark: {
      ...identity,
      target: containerised && identity.target !== 'dgx-spark' ? 'docker' : identity.target,
    },
    detectedAt: new Date().toISOString(),
  };
}

/**
 * The subset that belongs in a run manifest and therefore in evidence.
 *
 * Deliberately small and deliberately stable: this is hashed into a bundle, so
 * it must not contain anything that changes between two runs of the same
 * configuration. Free memory, utilisation and timestamps are excluded for that
 * reason — they are telemetry, not identity.
 */
export interface ExecutionEnvironmentRecord {
  platform: string;
  architecture: string;
  kernel: string;
  os?: string;
  cpuModel?: string;
  cpuCores: number;
  memoryTotalBytes: number;
  gpuName?: string;
  gpuComputeCapability?: string;
  gpuCount?: number;
  cudaVersion?: string;
  driverVersion?: string;
  deploymentTarget: DeploymentTarget;
  dgxSpark: boolean;
}

export function toEnvironmentRecord(caps: SystemCapabilities): ExecutionEnvironmentRecord {
  const gpus = valueOf(caps.gpu);
  const first = gpus?.[0];
  return {
    platform: caps.platform,
    architecture: caps.architecture,
    kernel: caps.kernel,
    ...(valueOf(caps.os) ? { os: valueOf(caps.os) } : {}),
    ...(caps.cpu.model ? { cpuModel: caps.cpu.model } : {}),
    cpuCores: caps.cpu.cores,
    memoryTotalBytes: caps.memory.totalBytes,
    ...(first?.name ? { gpuName: first.name } : {}),
    ...(first?.computeCapability ? { gpuComputeCapability: first.computeCapability } : {}),
    ...(gpus ? { gpuCount: gpus.length } : {}),
    ...(valueOf(caps.cuda) ? { cudaVersion: valueOf(caps.cuda) } : {}),
    ...(valueOf(caps.driver) ? { driverVersion: valueOf(caps.driver) } : {}),
    deploymentTarget: caps.dgxSpark.target,
    dgxSpark: caps.dgxSpark.detected,
  };
}
