/**
 * Compute.
 *
 * Every value on this screen comes from /v1/system/*. There is no hardware
 * table in this file — not a memory size, not a bandwidth figure, not a CUDA
 * version — because a dashboard that renders a specification sheet is
 * reporting the datasheet rather than the machine, and the two diverge exactly
 * when it matters.
 *
 * The probe shape drives the rendering: a fact that could not be measured is
 * shown as unavailable with its reason, never as zero. A GPU panel reading
 * "0%" because nvidia-smi is missing is worse than one reading "unavailable",
 * because the first looks like a measurement.
 */

import { AlertTriangle, Check, Cpu, HardDrive, Minus, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type RuntimeStatus,
  type SystemCapabilities,
  type SystemHealth,
  type SystemProbe,
} from '../lib/api';

function message(e: unknown): string {
  return e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e);
}

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

export function ComputePage() {
  const [caps, setCaps] = useState<SystemCapabilities | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      // Runtimes make a real network request per runtime, so this is slower
      // than it looks. That is the cost of not guessing.
      const [c, h, r] = await Promise.all([
        api.system.capabilities(),
        api.system.health(),
        api.system.runtimes(),
      ]);
      setCaps(c);
      setHealth(h);
      setRuntimes(r.items);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">Compute</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            What this machine is, measured from it. Nothing here is read from a specification
            sheet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5 text-sm hover:border-[var(--text-muted)] disabled:opacity-60"
        >
          <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {refreshing ? 'Probing…' : 'Re-probe'}
        </button>
      </header>

      {error ? (
        <p className="rounded-md border border-[var(--broken)] px-3 py-2 text-sm text-[var(--broken)]">
          {error}
        </p>
      ) : null}

      {caps ? <PlatformCard caps={caps} /> : null}
      {caps ? <HostFacts caps={caps} /> : null}
      {health ? <ComponentTable health={health} /> : null}
      {runtimes ? <RuntimeTable runtimes={runtimes} /> : null}

      {!caps && !error ? (
        <p className="text-sm text-[var(--text-muted)]">Probing this host…</p>
      ) : null}
    </section>
  );
}

/**
 * The verdict, with its reasoning visible.
 *
 * The evidence list is shown rather than hidden behind the boolean, because
 * "why does my DGX Spark report false" is the first question this screen will
 * be asked, and the answer is already computed.
 */
function PlatformCard({ caps }: { caps: SystemCapabilities }) {
  const detected = caps.dgxSpark.detected;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Server className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
        <p className="font-medium">
          {detected ? 'NVIDIA DGX Spark' : 'Not a recognised DGX Spark'}
        </p>
        <span
          className="rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          style={{
            borderColor: detected ? 'var(--sealed)' : 'var(--border)',
            color: detected ? 'var(--sealed)' : 'var(--text-muted)',
          }}
        >
          {caps.dgxSpark.target}
        </span>
      </div>

      <ul className="mt-3 space-y-1">
        {caps.dgxSpark.evidence.map((line) => (
          <li key={line} className="font-mono text-xs text-[var(--text-muted)]">
            {line}
          </li>
        ))}
      </ul>

      {!detected ? (
        <p className="mt-3 border-t border-[var(--border)] pt-3 text-sm text-[var(--text-muted)]">
          Evaluation against remote providers works normally here. Local GPU execution needs an
          arm64 Linux host with a Grace Blackwell GPU.
        </p>
      ) : null}
    </div>
  );
}

function HostFacts({ caps }: { caps: SystemCapabilities }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
      <Fact label="Platform" Icon={Cpu} value={`${caps.platform} / ${caps.architecture}`} />
      <Fact label="Kernel" value={caps.kernel} mono />
      <Fact label="CPU" value={`${caps.cpu.model ?? 'unknown model'} · ${caps.cpu.cores} cores`} />
      <Fact
        label="System memory"
        Icon={HardDrive}
        value={`${gib(caps.memory.totalBytes)} total · ${gib(caps.memory.freeBytes)} free`}
      />
      <ProbeFact label="Unified memory" probe={caps.memory.unified} render={(v) => (v ? 'yes' : 'no')} />
      <ProbeFact label="CUDA" probe={caps.cuda} render={(v) => v} />
      <ProbeFact label="Driver" probe={caps.driver} render={(v) => v} />
      <ProbeFact
        label="GPU"
        probe={caps.gpu}
        render={(devices) =>
          devices
            .map((d) => `${d.name}${d.computeCapability ? ` (cc ${d.computeCapability})` : ''}`)
            .join(', ')
        }
      />
      <ProbeFact label="Operating system" probe={caps.os} render={(v) => v} />
    </div>
  );
}

function Fact({
  label,
  value,
  Icon,
  mono,
}: {
  label: string;
  value: string;
  Icon?: typeof Cpu;
  mono?: boolean;
}) {
  return (
    <div className="bg-[var(--surface-raised)] p-4">
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {Icon ? <Icon className="size-3" aria-hidden="true" /> : null}
        {label}
      </p>
      <p className={`mt-1.5 break-words text-sm ${mono ? 'font-mono text-xs' : ''}`}>{value}</p>
    </div>
  );
}

/** Renders a measured value, or the reason there is none. Never a zero. */
function ProbeFact<T>({
  label,
  probe,
  render,
}: {
  label: string;
  probe: SystemProbe<T>;
  render: (value: T) => string;
}) {
  return (
    <div className="bg-[var(--surface-raised)] p-4">
      <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </p>
      {probe.status === 'ok' ? (
        <p className="mt-1.5 break-words text-sm">{render(probe.value)}</p>
      ) : (
        <p className="mt-1.5 flex items-start gap-1.5 text-sm text-[var(--text-muted)]">
          <Minus className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="italic">{probe.status}</span>
            <span className="mt-0.5 block text-xs">{probe.reason}</span>
          </span>
        </p>
      )}
    </div>
  );
}

function ComponentTable({ health }: { health: SystemHealth }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="border-b border-[var(--border)] bg-[var(--surface-raised)] px-4 py-2.5">
        <p className="text-sm font-medium">Components</p>
        {/* Not "healthy": this says which components answered. */}
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{health.summary}</p>
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {Object.entries(health.components).map(([name, component]) => (
          <li key={name} className="flex items-start gap-3 bg-[var(--surface-raised)] px-4 py-2.5">
            {component.status === 'ok' ? (
              <Check className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--sealed)' }} aria-hidden="true" />
            ) : (
              <Minus className="mt-0.5 size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            )}
            <span className="w-52 shrink-0 font-mono text-xs">{name}</span>
            <span className="text-xs text-[var(--text-muted)]">{component.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RuntimeTable({ runtimes }: { runtimes: RuntimeStatus[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)]">
      <div className="border-b border-[var(--border)] bg-[var(--surface-raised)] px-4 py-2.5">
        <p className="text-sm font-medium">Model runtimes</p>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          Configured and connected are separate columns on purpose: an endpoint somebody set is not
          an endpoint that answered.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              {['runtime', 'DGX Spark', 'configured', 'connection'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="bg-[var(--surface-raised)] px-4 py-2 font-mono text-[10px] font-normal uppercase tracking-wider text-[var(--text-muted)]"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runtimes.map((runtime) => (
              <tr key={runtime.id} className="border-b border-[var(--border)] bg-[var(--surface-raised)] last:border-0">
                <td className="px-4 py-3 align-top">
                  <p className="font-medium">{runtime.displayName}</p>
                  <p className="font-mono text-xs text-[var(--text-muted)]">{runtime.id}</p>
                </td>
                <td className="px-4 py-3 align-top">
                  <SupportBadge support={runtime.dgxSpark.support} />
                  <p className="mt-1 max-w-xs text-xs text-[var(--text-muted)]">
                    {runtime.dgxSpark.note}
                  </p>
                </td>
                <td className="px-4 py-3 align-top">
                  <span className="text-xs text-[var(--text-muted)]">
                    {runtime.configured ? runtime.baseUrl : 'no endpoint set'}
                  </span>
                </td>
                <td className="px-4 py-3 align-top">
                  <ConnectionCell connection={runtime.connection} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SupportBadge({ support }: { support: RuntimeStatus['dgxSpark']['support'] }) {
  const tone =
    support === 'documented'
      ? 'var(--sealed)'
      : support === 'unsupported'
        ? 'var(--broken)'
        : 'var(--text-muted)';
  return (
    <span
      className="inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
      style={{ borderColor: tone, color: tone }}
    >
      {support}
    </span>
  );
}

function ConnectionCell({ connection }: { connection: RuntimeStatus['connection'] }) {
  const connected = connection.status === 'connected';
  const tone = connected
    ? 'var(--sealed)'
    : connection.status === 'not_tested'
      ? 'var(--text-muted)'
      : 'var(--pending)';
  return (
    <div>
      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: tone }}>
        {connected ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-3.5" aria-hidden="true" />
        )}
        {connection.status}
      </span>
      {'detail' in connection && connection.detail ? (
        <p className="mt-1 max-w-xs text-xs text-[var(--text-muted)]">{connection.detail}</p>
      ) : null}
    </div>
  );
}
