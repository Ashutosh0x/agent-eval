/**
 * Runs and Audit log.
 *
 * Lifted verbatim out of App.tsx when routing was introduced. The only change
 * is permission awareness: controls the token cannot use are not offered.
 * Hiding them is a courtesy — the backend still refuses.
 */

import { useCallback, useEffect, useState } from 'react';
import { FileBadge, Link2, Unlink } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusBadge } from './RunDetail';
import { Digest } from '../components/Digest';
import { Seal, type SealState } from '../components/Seal';
import { ApiError, api, type AuditEntry, type RunRecord } from '../lib/api';
import { useIdentity } from '../lib/identity';

function describe(e: unknown, scope: string): string {
  if (e instanceof ApiError) {
    if (e.problem.status === 403) return `You do not have ${scope} permission for this action.`;
    if (e.problem.status === 401) return 'Your session is not authenticated. Sign in again.';
    return e.message;
  }
  return 'Could not reach the control plane.';
}

export function Runs({ onBundle }: { onBundle: (bundleId: string) => void }) {
  const { can } = useIdentity();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.runs
      .list()
      .then((r) => setRuns(r.items))
      .catch((e: unknown) => setError(describe(e, 'runs:read')));
  }, []);

  useEffect(load, [load]);

  async function seed() {
    setBusy('seed');
    try {
      await api.runs.start({
        environmentId: 'ghcr.io/acme/swe-env',
        environmentDigest: 'sha256:' + '3f'.repeat(32),
        taskSetId: 'swe-bench-verified',
        taskSetVersion: '2026.01',
        split: 'held-out',
        verifierId: 'pytest',
        verifierVersion: '3.1.0',
        model: { identifier: 'anthropic/claude-sonnet-4-5', sampling: { temperature: 0 } },
        seed: 42,
        isolationBackend: 'firecracker',
        toolchain: { 'agent-eval': '1.0.0', 'inspect-ai': '0.3.0' },
        retentionRules: ['eu-ai-act-art-19', 'hipaa-164-316'],
      });
      load();
    } catch (e) {
      setError(describe(e, 'runs:write'));
    } finally {
      setBusy(null);
    }
  }

  async function bundle(runId: string) {
    setBusy(runId);
    try {
      const { bundleId } = await api.evidence.generate(runId, [
        'eu-ai-act-art-19',
        'hipaa-164-316',
      ]);
      onBundle(bundleId);
    } catch (e) {
      setError(describe(e, 'evidence:generate'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-serif text-xl">Runs</h1>
        {can('runs:write') ? (
          <button
            type="button"
            onClick={seed}
            disabled={busy === 'seed'}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            {busy === 'seed' ? 'Starting…' : 'Start a run'}
          </button>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            Starting a run needs <span className="font-mono">runs:write</span>.
          </p>
        )}
      </div>

      {error ? <VerificationCallout message={error} /> : null}

      {runs === null ? (
        <p className="text-[var(--text-muted)]">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">
          No runs yet. Start one to produce an audit trail and an evidence bundle.
        </p>
      ) : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id}>
              <div
                role="link"
                tabIndex={0}
                onClick={() => navigate(`/runs/${r.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/runs/${r.id}`);
                  }
                }}
                aria-label={`Open run ${r.id}`}
                className="flex cursor-pointer flex-wrap items-center justify-between gap-4 rounded-lg border border-[var(--border)] p-4 hover:border-[var(--text-muted)] hover:bg-[var(--surface-raised)]"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm">{r.id}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
                    <span>{r.manifest.model.identifier}</span>
                    <span aria-hidden="true">·</span>
                    <span>{r.manifest.isolationBackend}</span>
                    <span aria-hidden="true">·</span>
                    {/* The digest carries its own copy button; keep the click
                        from bubbling up into the card navigation. */}
                    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Digest value={r.manifest.environment.digest} chars={7} />
                    </span>
                  </div>
                </div>

                {can('evidence:generate') ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      bundle(r.id);
                    }}
                    disabled={busy === r.id}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:border-[var(--text-muted)]"
                  >
                    <FileBadge className="size-4" aria-hidden="true" />
                    {busy === r.id ? 'Generating…' : 'Evidence bundle'}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [root, setRoot] = useState<{ root: string; size: number } | null>(null);
  const [chain, setChain] = useState<{ valid: boolean; brokenAt?: number; reason?: string } | null>(
    null,
  );

  useEffect(() => {
    api.audit.list().then((r) => setEntries(r.items));
    api.audit.root().then(setRoot);
  }, []);

  const sealState: SealState = chain ? (chain.valid ? 'sealed' : 'broken') : 'pending';

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="font-serif text-xl">Audit log</h1>
        <Seal
          state={sealState}
          onVerify={() => api.audit.verify().then(setChain)}
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
      </div>

      {root ? (
        <p className="text-sm text-[var(--text-muted)] flex items-center gap-2 flex-wrap">
          <Link2 className="size-4" aria-hidden="true" />
          <span>
            {root.size} {root.size === 1 ? 'entry' : 'entries'}, Merkle root
          </span>
          <Digest value={root.root} chars={10} />
          <span className="text-xs">— publish this to make later tampering provable</span>
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--text-muted)] text-xs">
            <tr className="border-b border-[var(--border)]">
              <th className="p-3 font-medium">Seq</th>
              <th className="p-3 font-medium">Action</th>
              <th className="p-3 font-medium">Actor</th>
              <th className="p-3 font-medium">Subject</th>
              <th className="p-3 font-medium">Entry hash</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e.seq} className="border-b border-[var(--border)] last:border-0">
                <td className="p-3 font-mono tabular">{e.seq}</td>
                <td className="p-3 font-mono text-xs">{e.action}</td>
                <td className="p-3">{e.actor}</td>
                <td className="p-3 font-mono text-xs">{e.subject ?? '—'}</td>
                <td className="p-3">
                  <Digest value={e.entryHash} chars={6} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {entries?.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          Nothing recorded yet. Start a run to produce entries.
        </p>
      ) : null}
    </section>
  );
}


/**
 * A failed verification is a state of the evidence, not a crash of the
 * software. "Refusing to sign a bundle over a broken chain" is the system
 * working — so it reads as a verification finding, with the specific position
 * the backend reported, and a route to the log rather than a retry button.
 */
function VerificationCallout({ message }: { message: string }) {
  const broken = /broken chain|does not follow|reordered|modified|gap/i.test(message);
  if (!broken) {
    return (
      <p className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)]">
        {message}
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-[var(--broken)] p-3">
      <Unlink className="mt-0.5 size-4 shrink-0 text-[var(--broken)]" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--broken)]">Unverified chain</p>
        <p className="mt-1 text-sm">{message}</p>
        <Link to="/audit" className="mt-2 inline-block text-sm underline">
          View audit log
        </Link>
      </div>
    </div>
  );
}
