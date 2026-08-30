/**
 * Compute page tests.
 *
 * The assertions are about what the screen refuses to say. A hardware panel
 * that renders "0%" for a metric it could not read, or a memory figure taken
 * from a specification sheet, is the exact failure this product argues
 * against — so the tests feed it probes that failed and check the failure
 * survives to the screen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ComputePage } from '../pages/Compute';

/** A host with no GPU stack at all — the case most likely to be faked. */
const BARE = {
  capabilities: {
    platform: 'linux',
    architecture: 'x64',
    isArm64: false,
    kernel: '6.8.0-generic',
    cpu: { model: 'Some CPU', cores: 8 },
    memory: {
      totalBytes: 16 * 1024 ** 3,
      freeBytes: 4 * 1024 ** 3,
      unified: { status: 'unknown', reason: 'unified memory is only asserted on a recognised GB10 system' },
    },
    gpu: { status: 'unavailable', reason: 'nvidia-smi is not installed or not on PATH' },
    cuda: { status: 'unavailable', reason: 'neither nvcc nor nvidia-smi reported a CUDA version' },
    driver: { status: 'unavailable', reason: 'no driver version reported by nvidia-smi' },
    docker: { status: 'unavailable', reason: 'docker is not installed or not on PATH' },
    nvidiaContainerRuntime: { status: 'unavailable', reason: 'docker is not installed or not on PATH' },
    os: { status: 'ok', value: 'Ubuntu 24.04 LTS' },
    dgxSpark: { detected: false, evidence: ['not arm64, so not a DGX Spark'], target: 'server' },
    detectedAt: '2026-08-30T12:00:00.000Z',
  },
  health: {
    summary: '5 component(s) unavailable or unknown',
    deploymentTarget: 'server',
    dgxSpark: false,
    components: {
      api: { status: 'ok', detail: 'this request was served' },
      gpu: { status: 'unavailable', detail: 'nvidia-smi is not installed or not on PATH' },
    },
    checkedAt: '2026-08-30T12:00:00.000Z',
  },
  runtimes: {
    items: [
      {
        id: 'vllm',
        displayName: 'vLLM',
        locality: 'local',
        dgxSpark: { support: 'documented', note: 'NVIDIA publishes a vLLM playbook for DGX Spark.' },
        requiresBaseUrl: false,
        configured: false,
        connection: { status: 'unavailable', detail: 'Connection refused at http://127.0.0.1:8000/v1' },
        platformNote: 'This host is not a recognised DGX Spark.',
      },
      {
        id: 'nim',
        displayName: 'NVIDIA NIM',
        locality: 'local',
        dgxSpark: { support: 'unknown', note: 'NIM containers are validated per GPU.' },
        requiresBaseUrl: true,
        configured: false,
        connection: { status: 'not_configured', detail: 'NVIDIA NIM needs a base URL.' },
        platformNote: 'This host is not a recognised DGX Spark.',
      },
    ],
    host: { target: 'server', isArm64: false },
  },
};

/** A recognised DGX Spark, to check the positive path is equally evidenced. */
const SPARK = {
  ...BARE,
  capabilities: {
    ...BARE.capabilities,
    architecture: 'arm64',
    isArm64: true,
    cpu: { model: 'Cortex-X925', cores: 20 },
    memory: {
      totalBytes: 128 * 1024 ** 3,
      freeBytes: 100 * 1024 ** 3,
      unified: { status: 'ok', value: true },
    },
    gpu: { status: 'ok', value: [{ name: 'NVIDIA GB10', computeCapability: '12.1' }] },
    cuda: { status: 'ok', value: '13.0' },
    driver: { status: 'ok', value: '580.65' },
    dgxSpark: {
      detected: true,
      evidence: ['architecture is arm64', 'platform is linux', 'GPU name matches GB10: "NVIDIA GB10"'],
      target: 'dgx-spark',
    },
  },
};

/**
 * The fixtures differ in shape by design — one has probes that succeeded, the
 * other probes that failed — so the parameter is typed by what this function
 * uses rather than by one of them.
 */
interface Fixture {
  capabilities: unknown;
  health: unknown;
  runtimes: unknown;
}

function mockApi(fixture: Fixture) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/runtimes')
        ? fixture.runtimes
        : url.includes('/health')
          ? fixture.health
          : fixture.capabilities;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('agent-eval.token', 'acme:you@example.test:runs:read');
});

afterEach(() => vi.unstubAllGlobals());

describe('a host with no GPU stack', () => {
  it('says unavailable rather than showing a zero', async () => {
    mockApi(BARE);
    render(<ComputePage />);

    await waitFor(() => expect(screen.getAllByText('unavailable').length).toBeGreaterThan(0));

    // The specific failure this guards: a missing probe rendered as a reading.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b0\s*%/);
    expect(text).toContain('nvidia-smi is not installed or not on PATH');
  });

  it('does not claim DGX Spark, and shows why', async () => {
    mockApi(BARE);
    render(<ComputePage />);
    await waitFor(() =>
      expect(screen.getByText('Not a recognised DGX Spark')).toBeInTheDocument(),
    );
    expect(screen.getByText('not arm64, so not a DGX Spark')).toBeInTheDocument();
  });

  it('reports unified memory as unknown, not as false', async () => {
    mockApi(BARE);
    render(<ComputePage />);
    await waitFor(() => expect(screen.getAllByText('unknown').length).toBeGreaterThan(0));
    expect(document.body.textContent).toContain('only asserted on a recognised GB10 system');
  });

  it('shows measured memory, never a specification figure', async () => {
    mockApi(BARE);
    render(<ComputePage />);
    // 16 GiB is what the probe reported. 128 GiB is what a datasheet would say.
    await waitFor(() => expect(document.body.textContent).toContain('16.0 GiB total'));
    expect(document.body.textContent).not.toContain('128.0 GiB');
  });

  it('keeps configured and connected as separate claims', async () => {
    mockApi(BARE);
    render(<ComputePage />);
    // Both fixture runtimes are unconfigured, so there are two of these.
    await waitFor(() => expect(screen.getAllByText('no endpoint set')).toHaveLength(2));
    expect(document.body.textContent).toContain('Connection refused');
  });

  it('reports NIM support as unknown rather than assuming it works', async () => {
    mockApi(BARE);
    render(<ComputePage />);
    await waitFor(() => expect(screen.getByText('NVIDIA NIM')).toBeInTheDocument());
    expect(document.body.textContent).toContain('validated per GPU');
  });

  it('summarises components without calling them healthy', async () => {
    mockApi(BARE);
    render(<ComputePage />);
    await waitFor(() => expect(screen.getByText(/component\(s\) unavailable/)).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/all systems healthy/i);
  });
});

describe('a recognised DGX Spark', () => {
  it('names the platform and shows the evidence for the verdict', async () => {
    mockApi(SPARK);
    render(<ComputePage />);
    await waitFor(() => expect(screen.getByText('NVIDIA DGX Spark')).toBeInTheDocument());
    expect(screen.getByText(/GPU name matches GB10/)).toBeInTheDocument();
    expect(screen.getByText('dgx-spark')).toBeInTheDocument();
  });

  it('renders measured GPU and CUDA values', async () => {
    mockApi(SPARK);
    render(<ComputePage />);
    await waitFor(() => expect(document.body.textContent).toContain('NVIDIA GB10 (cc 12.1)'));
    expect(document.body.textContent).toContain('13.0');
    expect(document.body.textContent).toContain('580.65');
  });

  it('reports the memory the probe measured', async () => {
    mockApi(SPARK);
    render(<ComputePage />);
    await waitFor(() => expect(document.body.textContent).toContain('128.0 GiB total'));
  });
});

describe('failure handling', () => {
  it('surfaces an API error instead of rendering an empty machine', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ type: 'x', title: 'Forbidden', status: 403, detail: 'needs runs:read' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    render(<ComputePage />);
    await waitFor(() => expect(screen.getByText('needs runs:read')).toBeInTheDocument());
    // No invented hardware panel behind the error.
    expect(screen.queryByText('NVIDIA DGX Spark')).not.toBeInTheDocument();
  });
});
