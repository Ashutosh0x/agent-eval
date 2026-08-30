/**
 * Run detail — the investigation screen.
 *
 * On what fills the three panes: the backend has no trajectory. A run carries
 * id, status, manifest, retentionRules and timestamps, and nothing else — no
 * trials, no steps, no ATIF. Rendering a fabricated transcript here would put
 * invented model output on the screen of an audit-grade product, which is the
 * one thing this codebase must never do.
 *
 * What does exist is the audit trail for the run: real entries, sequentially
 * numbered, hash-chained, each with an inclusion proof. That is a genuine
 * record of what happened, so it is what the panes show. When trajectory
 * ingestion lands, the transcript pane gains steps beside these entries; the
 * layout already has the shape for it.
 *
 * The Graph tab says so plainly rather than drawing empty nodes.
 */

import {
  ArrowLeft,
  BadgeCheck,
  Copy,
  Eye,
  FileBadge,
  Link2,
  MessageSquare,
  RefreshCw,
  Scale,
  Settings2,
  Terminal,
  Unlink,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Digest } from '../components/Digest';
import { Seal, type SealState } from '../components/Seal';
import { ApiError, api, type AuditEntry, type RunRecord } from '../lib/api';
import { useIdentity } from '../lib/identity';

/** Semantic mark per audit action. Icons carry meaning, never decoration. */
function iconFor(action: string) {
  if (action.startsWith('approval')) return Scale;
  if (action.startsWith('tool')) return Terminal;
  if (action.startsWith('evidence')) return BadgeCheck;
  if (action.startsWith('api-key')) return Settings2;
  if (action.includes('observation')) return Eye;
  return MessageSquare;
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useIdentity();

  const [run, setRun] = useState<RunRecord | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<'transcript' | 'graph'>('transcript');
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound' | 'forbidden' | 'error'>(
    'loading',
  );
  const [chain, setChain] = useState<{ valid: boolean; brokenAt?: number; reason?: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Mobile only: which pane is showing. */
  const [pane, setPane] = useState<'entries' | 'transcript' | 'inspector'>('transcript');

  const load = useCallback(() => {
    setStatus('loading');
    api.runs
      .get(runId)
      .then(async (r) => {
        setRun(r);
        setStatus('ok');
        if (can('audit:read')) {
          try {
            const a = await api.audit.list();
            setEntries(a.items.filter((e) => e.subject === runId));
          } catch {
            // An audit read failing must not take the run page down with it.
            setEntries([]);
          }
        }
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError) {
          setStatus(e.problem.status === 404 ? 'notfound' : e.problem.status === 403 ? 'forbidden' : 'error');
        } else setStatus('error');
      });
  }, [runId, can]);

  useEffect(load, [load]);

  const selectedEntry = useMemo(
    () => entries.find((e) => e.seq === selected) ?? null,
    [entries, selected],
  );

  if (status === 'loading') return <Skeleton />;

  if (status === 'notfound')
    return (
      <Failure title="Run not found">
        <p className="font-mono text-xs text-[var(--text-muted)]">{runId}</p>
        <Link to="/runs" className="mt-3 inline-block text-sm underline">
          Back to runs
        </Link>
      </Failure>
    );

  if (status === 'forbidden')
    return (
      <Failure title="Not permitted">
        <p className="text-sm text-[var(--text-muted)]">
          You do not have <span className="font-mono">runs:read</span> permission for this run.
        </p>
      </Failure>
    );

  if (status === 'error' || !run)
    return (
      <Failure title="Unable to load run">
        <button type="button" onClick={load} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">
          <RefreshCw className="size-4" aria-hidden="true" />
          Retry
        </button>
      </Failure>
    );

  const m = run.manifest;
  const sealState: SealState = chain ? (chain.valid ? 'sealed' : 'broken') : 'pending';

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ header */}
      <header className="space-y-3">
        <Link
          to="/runs"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Runs
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-lg">{run.id}</h1>
              <StatusBadge status={run.status} />
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(run.id).catch(() => {})}
                aria-label="Copy run ID"
                className="text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <Copy className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Created {new Date(run.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {can('audit:read') ? (
              <Seal
                state={sealState}
                onVerify={() => api.audit.verify().then(setChain).catch(() => {})}
                detail={
                  chain
                    ? {
                        chain: chain.valid,
                        brokenAt: chain.brokenAt,
                        failures: chain.reason ? [chain.reason] : [],
                      }
                    : undefined
                }
              />
            ) : null}

            {can('evidence:generate') ? (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setActionError(null);
                  try {
                    const { bundleId } = await api.evidence.generate(run.id, run.retentionRules);
                    navigate(`/bundles/${bundleId}`);
                  } catch (e) {
                    setActionError(e instanceof ApiError ? e.message : 'Could not generate a bundle.');
                  } finally {
                    setBusy(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:border-[var(--text-muted)] disabled:opacity-50"
              >
                <FileBadge className="size-4" aria-hidden="true" />
                {busy ? 'Generating…' : 'Generate evidence bundle'}
              </button>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">
                Evidence generation needs <span className="font-mono">evidence:generate</span>.
              </p>
            )}
          </div>
        </div>

        {actionError ? <Callout title="Could not generate bundle" body={actionError} /> : null}
      </header>

      {/* ---------------------------------------------------------- metadata */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-[var(--border)] p-4 sm:grid-cols-3 lg:grid-cols-4">
        <Meta label="Model">{m.model.identifier}</Meta>
        <Meta label="Isolation">{m.isolationBackend}</Meta>
        <Meta label="Image">
          <Digest value={m.environment.digest} chars={7} />
        </Meta>
        <Meta label="Verifier">
          {m.verifier.id}@{m.verifier.version}
        </Meta>
        <Meta label="Task set">
          {m.taskSet.id} · {m.taskSet.split}
        </Meta>
        <Meta label="Seed">
          <span className="tabular">{m.seed === null ? 'not seeded' : m.seed}</span>
        </Meta>
        <Meta label="Sampling">
          <span className="text-xs">{JSON.stringify(m.model.sampling)}</span>
        </Meta>
        <Meta label="Retention">{run.retentionRules.join(', ')}</Meta>
      </dl>

      {/* ------------------------------------------------- mobile pane tabs */}
      <div className="flex gap-1 lg:hidden">
        {(['entries', 'transcript', 'inspector'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPane(p)}
            aria-current={pane === p ? 'true' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm capitalize ${
              pane === p ? 'bg-[var(--surface-raised)] font-medium' : 'text-[var(--text-muted)]'
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------- three panes */}
      <div className="grid gap-4 lg:grid-cols-[13rem_1fr_20rem]">
        <Pane title="Entries" show={pane === 'entries'}>
          {entries.length === 0 ? (
            <Empty>
              {can('audit:read')
                ? 'No audit entries for this run.'
                : 'Reading the audit trail needs audit:read.'}
            </Empty>
          ) : (
            <ul className="max-h-[28rem] overflow-y-auto">
              {entries.map((e) => {
                const Icon = iconFor(e.action);
                const active = selected === e.seq;
                return (
                  <li key={e.seq}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(e.seq);
                        setPane('inspector');
                      }}
                      aria-current={active ? 'true' : undefined}
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                        active ? 'bg-[var(--surface-raised)]' : 'hover:bg-[var(--surface-raised)]'
                      }`}
                    >
                      {/* Bates-style sequence marker: gapless and citable. */}
                      <span className="w-6 shrink-0 font-mono text-xs tabular text-[var(--text-muted)]">
                        {String(e.seq).padStart(2, '0')}
                      </span>
                      <Icon className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                      <span className="truncate font-mono text-xs">{e.action}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Pane>

        <Pane
          title="Transcript"
          show={pane === 'transcript'}
          tabs={
            <div className="flex gap-1">
              {(['transcript', 'graph'] as const).map((mm) => (
                <button
                  key={mm}
                  type="button"
                  onClick={() => setMode(mm)}
                  className={`rounded px-2 py-0.5 text-xs capitalize ${
                    mode === mm ? 'bg-[var(--surface)] font-medium' : 'text-[var(--text-muted)]'
                  }`}
                >
                  {mm}
                </button>
              ))}
            </div>
          }
        >
          {mode === 'graph' ? (
            <Empty>
              <span className="block font-medium text-[var(--text)]">Graph unavailable</span>
              This run does not carry trajectory structure — the control plane records audit
              entries, not agent steps, so there are no nodes or edges to draw.
            </Empty>
          ) : entries.length === 0 ? (
            <Empty>Nothing recorded against this run yet.</Empty>
          ) : (
            <ol className="max-h-[28rem] divide-y divide-[var(--border)] overflow-y-auto">
              {entries.map((e) => (
                <li key={e.seq} className="p-3">
                  <button
                    type="button"
                    onClick={() => setSelected(e.seq)}
                    className="w-full text-left"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-xs tabular text-[var(--text-muted)]">
                        {String(e.seq).padStart(2, '0')}
                      </span>
                      <span className="font-mono text-xs uppercase tracking-wide">
                        {e.action.replace(/[._]/g, ' ')}
                      </span>
                      <span className="ml-auto text-xs tabular text-[var(--text-muted)]">
                        {e.recordedAt.slice(11, 19)}
                      </span>
                    </div>
                    <p className="mt-1 pl-9 text-xs text-[var(--text-muted)]">by {e.actor}</p>
                    {Object.keys(e.payload).length > 0 ? (
                      <dl className="mt-1.5 space-y-0.5 pl-9">
                        {Object.entries(e.payload).map(([k, v]) => (
                          <div key={k} className="flex gap-2 text-xs">
                            <dt className="text-[var(--text-muted)]">{k}</dt>
                            <dd className="min-w-0 truncate font-mono">{String(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Pane>

        <Pane title="Inspector" show={pane === 'inspector'}>
          {!selectedEntry ? (
            <Empty>Select an entry to inspect its record.</Empty>
          ) : (
            <div className="space-y-3 p-3">
              <dl className="space-y-2 text-xs">
                <Row label="Entry">
                  <span className="font-mono tabular">#{selectedEntry.seq}</span>
                </Row>
                <Row label="Action">
                  <span className="font-mono">{selectedEntry.action}</span>
                </Row>
                <Row label="Actor">{selectedEntry.actor}</Row>
                <Row label="Recorded">
                  <span className="tabular">{selectedEntry.recordedAt.slice(0, 19).replace('T', ' ')}</span>
                </Row>
                <Row label="Entry hash">
                  <Digest value={selectedEntry.entryHash} chars={8} />
                </Row>
                <Row label="Links to">
                  <Digest value={selectedEntry.previousHash} chars={8} />
                </Row>
                <Row label="Chain position">
                  <span className="tabular">
                    {selectedEntry.seq} of {entries.length} for this run
                  </span>
                </Row>
              </dl>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <h4 className="text-xs font-medium">Raw record</h4>
                  <button
                    type="button"
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(JSON.stringify(selectedEntry, null, 2))
                        .catch(() => {})
                    }
                    aria-label="Copy raw record"
                    className="text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
                <pre className="max-h-64 overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(selectedEntry, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </Pane>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Pane({
  title,
  show,
  tabs,
  children,
}: {
  title: string;
  show: boolean;
  tabs?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`${show ? 'block' : 'hidden'} rounded-lg border border-[var(--border)] lg:block`}>
      <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          {title}
        </h3>
        {tabs}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-xs leading-relaxed text-[var(--text-muted)]">{children}</p>;
}

function Failure({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-12 text-center">
      <h1 className="text-lg font-medium">{title}</h1>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Callout({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-[var(--broken)] p-3">
      <Unlink className="mt-0.5 size-4 shrink-0 text-[var(--broken)]" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-[var(--broken)]">{title}</p>
        <p className="mt-0.5 text-sm">{body}</p>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  // Icon + word, never colour alone.
  const Icon = status === 'failed' ? Unlink : status === 'completed' ? BadgeCheck : Link2;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">
      <Icon className="size-3" aria-hidden="true" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-6 w-48 rounded bg-[var(--surface-raised)]" />
      <div className="h-24 rounded-lg border border-[var(--border)]" />
      <div className="grid gap-4 lg:grid-cols-[13rem_1fr_20rem]">
        <div className="h-72 rounded-lg border border-[var(--border)]" />
        <div className="h-72 rounded-lg border border-[var(--border)]" />
        <div className="h-72 rounded-lg border border-[var(--border)]" />
      </div>
    </div>
  );
}
