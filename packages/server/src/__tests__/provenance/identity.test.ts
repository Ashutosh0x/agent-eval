import { describe, it, expect } from 'vitest';
import {
  ACCELERATOR_VENDORS,
  deploymentDigest,
  describeAccelerator,
  describeModel,
  diffExecutions,
  executionDigest,
  isSameExecution,
  isSameModel,
  modelDigest,
  pinningStrength,
  type DeploymentIdentity,
  type EvaluatedModel,
  type ModelIdentity,
} from '../../provenance/identity.js';

const QWEN: ModelIdentity = {
  repository: 'Qwen/Qwen3-8B',
  origin: 'hub',
  revision: 'main',
  commitSha: 'a'.repeat(40),
  architecture: 'qwen3',
  parameterCount: 8_000_000_000,
};

function deployment(over: Partial<DeploymentIdentity> = {}): DeploymentIdentity {
  return {
    provider: 'vllm',
    servedModelId: 'Qwen/Qwen3-8B',
    runtime: { engine: 'vllm', engineVersion: '0.6.0', precision: 'bf16' },
    accelerator: { vendor: ACCELERATOR_VENDORS.NVIDIA, model: 'H100', count: 1, memoryGb: 80 },
    endpoint: 'http://gpu-1:8000/v1',
    ...over,
  };
}

describe('one model, many deployments', () => {
  // The central distinction: the same weights served three ways.
  const onVllm: EvaluatedModel = { model: QWEN, deployment: deployment() };
  const onNim: EvaluatedModel = {
    model: QWEN,
    deployment: deployment({
      provider: 'nim',
      runtime: { engine: 'nim', engineVersion: '1.2', precision: 'bf16' },
    }),
  };
  const onLaptop: EvaluatedModel = {
    model: QWEN,
    deployment: deployment({
      provider: 'ollama',
      runtime: { engine: 'ollama', precision: 'int4', quantization: 'q4_K_M' },
      accelerator: { vendor: ACCELERATOR_VENDORS.APPLE, model: 'M3 Max' },
      endpoint: 'http://127.0.0.1:11434/v1',
    }),
  };

  it('gives all three the same model digest', () => {
    // Without this, "Qwen on vLLM vs Qwen on NIM" is two unrelated rows
    // instead of a comparison.
    expect(modelDigest(onNim.model)).toBe(modelDigest(onVllm.model));
    expect(isSameModel(onVllm, onLaptop)).toBe(true);
  });

  it('gives all three different deployment digests', () => {
    const digests = new Set([
      deploymentDigest(onVllm.deployment),
      deploymentDigest(onNim.deployment),
      deploymentDigest(onLaptop.deployment),
    ]);
    expect(digests.size).toBe(3);
  });

  it('gives all three different execution digests', () => {
    expect(isSameExecution(onVllm, onNim)).toBe(false);
    expect(isSameExecution(onVllm, onVllm)).toBe(true);
  });

  it('explains what differs, rather than only that something does', () => {
    // "Not apples-to-apples" with no reason trains people to ignore it.
    const diffs = diffExecutions(onVllm, onLaptop);
    const dims = diffs.map((d) => d.dimension);
    expect(dims).toContain('runtime');
    expect(dims).toContain('hardware');
    expect(dims).toContain('quantization');
    // Same weights, so the model must NOT be listed as a difference.
    expect(dims).not.toContain('model');
  });

  it('reports no differences between an execution and itself', () => {
    expect(diffExecutions(onVllm, onVllm)).toEqual([]);
  });
});

describe('model digest pins what actually identifies weights', () => {
  it('changes when the commit changes', () => {
    const other = { ...QWEN, commitSha: 'b'.repeat(40) };
    expect(modelDigest(other)).not.toBe(modelDigest(QWEN));
  });

  it('changes when the repository changes', () => {
    expect(modelDigest({ ...QWEN, repository: 'Qwen/Qwen3-32B' })).not.toBe(modelDigest(QWEN));
  });

  it('changes when the tokenizer revision changes', () => {
    // A tokenizer can be revised independently and changes what the model sees.
    const a = { ...QWEN, tokenizerRepository: 'Qwen/Qwen3-8B', tokenizerRevision: 'v1' };
    const b = { ...a, tokenizerRevision: 'v2' };
    expect(modelDigest(a)).not.toBe(modelDigest(b));
  });

  it('distinguishes an unpinned model from the same repo at a known revision', () => {
    // They are different claims, not the same one with detail omitted.
    const unpinned: ModelIdentity = { repository: 'Qwen/Qwen3-8B', origin: 'hub' };
    expect(modelDigest(unpinned)).not.toBe(modelDigest(QWEN));
  });

  it('ignores descriptive metadata that does not change the weights', () => {
    // Architecture and parameter count are documentation, not identity: two
    // records of the same commit must not fragment because one filled them in.
    const annotated = { ...QWEN, architecture: 'qwen3-moe', parameterCount: 1 };
    expect(modelDigest(annotated)).toBe(modelDigest(QWEN));
  });

  it('is a pinned sha256', () => {
    expect(modelDigest(QWEN)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('deployment digest covers the serving stack', () => {
  it('changes with the inference engine', () => {
    const a = deployment();
    const b = deployment({ runtime: { engine: 'sglang', precision: 'bf16' } });
    expect(deploymentDigest(a)).not.toBe(deploymentDigest(b));
  });

  it('changes with precision', () => {
    const a = deployment({ runtime: { engine: 'vllm', precision: 'bf16' } });
    const b = deployment({ runtime: { engine: 'vllm', precision: 'fp8' } });
    expect(deploymentDigest(a)).not.toBe(deploymentDigest(b));
  });

  it('changes with the accelerator', () => {
    const nvidia = deployment();
    const amd = deployment({
      accelerator: { vendor: ACCELERATOR_VENDORS.AMD, model: 'MI300X', count: 1 },
    });
    expect(deploymentDigest(nvidia)).not.toBe(deploymentDigest(amd));
  });

  it('changes with the container digest, which pins a runtime harder than a version', () => {
    const a = deployment({
      runtime: { engine: 'nim', containerDigest: `sha256:${'1'.repeat(64)}` },
    });
    const b = deployment({
      runtime: { engine: 'nim', containerDigest: `sha256:${'2'.repeat(64)}` },
    });
    expect(deploymentDigest(a)).not.toBe(deploymentDigest(b));
  });

  it('is stable against toolkit key ordering', () => {
    // Insertion order must not change a digest, or the same machine hashes
    // differently on two runs.
    const a = deployment({
      accelerator: {
        vendor: 'nvidia',
        toolkitVersions: { cuda: '12.4', driver: '550.54' },
      },
    });
    const b = deployment({
      accelerator: {
        vendor: 'nvidia',
        toolkitVersions: { driver: '550.54', cuda: '12.4' },
      },
    });
    expect(deploymentDigest(a)).toBe(deploymentDigest(b));
  });
});

describe('vendor neutrality', () => {
  it('represents every accelerator vendor through the same shape', () => {
    // No vendor gets a privileged field. A new accelerator is a value.
    const vendors = [
      { vendor: 'nvidia', model: 'H100', toolkitVersions: { cuda: '12.4' } },
      { vendor: 'amd', model: 'MI300X', toolkitVersions: { rocm: '6.1' } },
      { vendor: 'google', model: 'TPU v5e' },
      { vendor: 'aws', model: 'Trainium2' },
      { vendor: 'cpu' },
    ];
    const digests = vendors.map((accelerator) => deploymentDigest(deployment({ accelerator })));
    expect(new Set(digests).size).toBe(vendors.length);
  });

  it('accepts an accelerator vendor the codebase has never heard of', () => {
    // A closed enum would make a new accelerator unrepresentable.
    const exotic = deployment({ accelerator: { vendor: 'some-new-npu-vendor', model: 'X1' } });
    expect(deploymentDigest(exotic)).toMatch(/^sha256:/);
    expect(describeAccelerator(exotic.accelerator)).toContain('some-new-npu-vendor');
  });

  it('names no vendor in the identity module itself', () => {
    // The constants map vendor names to strings; the LOGIC must not branch on
    // them. A conditional on a vendor here is the bias this file prevents.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'provenance', 'identity.ts'),
      'utf8',
    ) as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // No comparison against a vendor literal anywhere in executable code.
    expect(code).not.toMatch(/===\s*'nvidia'/);
    expect(code).not.toMatch(/===\s*'amd'/);
    expect(code).not.toMatch(/vendor\s*===/);
  });
});

describe('pinning strength', () => {
  it('reports exact for a weights digest', () => {
    const p = pinningStrength({ ...QWEN, weightsDigest: `sha256:${'c'.repeat(64)}` });
    expect(p.strength).toBe('exact');
  });

  it('reports revision for a commit sha', () => {
    expect(pinningStrength(QWEN).strength).toBe('revision');
  });

  it('reports alias for a provider-reported revision only', () => {
    const p = pinningStrength({ repository: 'openai/gpt', origin: 'proprietary_api', revision: '2026-09-03' });
    expect(p.strength).toBe('alias');
  });

  it('reports unpinned, and says a later run may differ', () => {
    const p = pinningStrength({ repository: 'openai/gpt', origin: 'proprietary_api' });
    expect(p.strength).toBe('unpinned');
    expect(p.reason).toMatch(/different weights/i);
  });

  it('always explains the consequence, never only the label', () => {
    for (const m of [
      QWEN,
      { ...QWEN, weightsDigest: 'sha256:x' },
      { repository: 'r', origin: 'hub' as const },
    ]) {
      expect(pinningStrength(m).reason.length).toBeGreaterThan(20);
    }
  });
});

describe('description helpers', () => {
  it('abbreviates a commit rather than printing 40 characters', () => {
    expect(describeModel(QWEN)).toBe('Qwen/Qwen3-8B@aaaaaaaaaaaa');
  });

  it('falls back to the repository when nothing is pinned', () => {
    expect(describeModel({ repository: 'x/y', origin: 'hub' })).toBe('x/y');
  });

  it('says hardware is unspecified rather than inventing one', () => {
    expect(describeAccelerator(undefined)).toMatch(/unspecified/);
  });

  it('shows accelerator count when there is more than one', () => {
    expect(describeAccelerator({ vendor: 'nvidia', model: 'H100', count: 8 })).toBe(
      '8x nvidia H100',
    );
  });
});

describe('execution digest', () => {
  it('binds both halves', () => {
    const e: EvaluatedModel = { model: QWEN, deployment: deployment() };
    const changedModel = { ...e, model: { ...QWEN, commitSha: 'f'.repeat(40) } };
    const changedDeploy = { ...e, deployment: deployment({ provider: 'nim' }) };
    expect(executionDigest(changedModel)).not.toBe(executionDigest(e));
    expect(executionDigest(changedDeploy)).not.toBe(executionDigest(e));
  });
});
