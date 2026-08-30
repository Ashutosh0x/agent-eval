/**
 * The evidence bundle view — the compliance reviewer's screen, and the one
 * most likely to be printed.
 *
 * The rule this screen exists to honour: never render a green-tick compliance
 * matrix. The evidence layer distinguishes satisfies / supports / exceeds with
 * mandatory caveats, and a checkmark column would collapse that distinction —
 * quietly destroying the main differentiator and, worse, telling a compliance
 * officer that "stronger than required" means "required and met".
 *
 * So strength renders as a word, and caveats render inline and cannot be
 * collapsed away, including in print.
 */

import { useEffect, useState } from 'react';
import { FileBadge, Printer } from 'lucide-react';
import { Digest } from '../components/Digest';
import { Seal, type SealState } from '../components/Seal';
import { api, type ArticleMapping, type BundleVerification, type EvidenceBundle } from '../lib/api';

const STRENGTH_STYLE: Record<ArticleMapping['strength'], string> = {
  satisfies: 'text-[var(--sealed)] border-[var(--sealed)]',
  // Visually distinct from satisfies on purpose. "Exceeds" must never read as
  // "required and met".
  exceeds: 'text-[var(--pending)] border-[var(--pending)] border-dashed',
  supports: 'text-[var(--text-muted)] border-[var(--border)]',
};

export function EvidenceBundleView({ bundleId }: { bundleId: string }) {
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [verification, setVerification] = useState<BundleVerification | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.evidence
      .get(bundleId)
      .then((b) => live && setBundle(b))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [bundleId]);

  async function verify() {
    try {
      setVerification(await api.evidence.verify(bundleId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <p className="text-[var(--broken)]">{error}</p>;
  if (!bundle) return <p className="text-[var(--text-muted)]">Loading bundle…</p>;

  const p = bundle.payload;

  const sealState: SealState = verification
    ? verification.valid
      ? 'sealed'
      : 'broken'
    : 'pending';

  return (
    <article className="max-w-4xl space-y-8">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[var(--text-muted)] text-sm">
            <FileBadge className="size-4" aria-hidden="true" />
            <span>Evidence bundle</span>
          </div>
          <h1 className="font-serif text-2xl">{p.bundleId}</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Covers run <span className="font-mono">{p.runId}</span>, generated{' '}
            {new Date(p.generatedAt).toISOString().slice(0, 10)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Seal
            state={sealState}
            onVerify={verify}
            detail={
              verification
                ? {
                    signature: verification.checks.signature,
                    chain: verification.checks.chain,
                    inclusion: verification.checks.inclusion,
                    keyId: bundle.signature.keyId,
                    expectedRoot: p.logRoot,
                    failures: verification.failures,
                  }
                : undefined
            }
          />
          <button
            type="button"
            onClick={() => window.print()}
            className="no-print inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            <Printer className="size-4" aria-hidden="true" />
            Print
          </button>
        </div>
      </header>

      {/* ---------------------------------------------------- reproducibility */}
      <section className="space-y-3">
        <h2 className="font-serif text-lg">What was run</h2>
        <p className="text-sm text-[var(--text-muted)]">
          Pinned values. Without these an evaluation result is a number, not evidence.
        </p>
        <dl className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
          <Pin label="Environment">
            <Digest value={p.manifest.environment.digest} chars={10} />
          </Pin>
          <Pin label="Model">
            <span>{p.manifest.model.identifier}</span>
          </Pin>
          <Pin label="Sampling">
            <span className="font-mono text-xs">{JSON.stringify(p.manifest.model.sampling)}</span>
          </Pin>
          <Pin label="Task set">
            <span>
              {p.manifest.taskSet.id} @ {p.manifest.taskSet.version} ·{' '}
              <span className="font-mono text-xs">{p.manifest.taskSet.split}</span>
            </span>
          </Pin>
          <Pin label="Split hash">
            <Digest value={p.manifest.taskSet.splitHash} />
          </Pin>
          <Pin label="Verifier">
            <span>
              {p.manifest.verifier.id} @ {p.manifest.verifier.version}
            </span>
          </Pin>
          <Pin label="Seed">
            <span className="font-mono tabular">
              {p.manifest.seed === null ? 'not seeded' : p.manifest.seed}
            </span>
          </Pin>
          <Pin label="Isolation">
            <span>{p.manifest.isolationBackend}</span>
          </Pin>
          <Pin label="Toolchain">
            <span className="font-mono text-xs">
              {Object.entries(p.manifest.toolchain)
                .map(([k, v]) => `${k}@${v}`)
                .join(', ')}
            </span>
          </Pin>
        </dl>
      </section>

      {/* ------------------------------------------------------------ mappings */}
      <section className="space-y-3">
        <h2 className="font-serif text-lg">Regulatory mapping</h2>
        <p className="text-sm text-[var(--text-muted)]">
          This bundle is input to a conformity assessment. It is not itself an assessment, and
          nothing below is a legal conclusion.
        </p>

        <ul className="space-y-3">
          {p.mappings.map((m, i) => (
            <li
              key={`${m.provision}-${i}`}
              className="mapping rounded-lg border border-[var(--border)] p-4 space-y-2"
            >
              <div className="flex items-baseline justify-between gap-4 flex-wrap">
                <h3 className="font-medium">{m.provision}</h3>
                {/* A word, never a tick. */}
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${STRENGTH_STYLE[m.strength]}`}
                >
                  {m.strength}
                </span>
              </div>
              <p className="text-sm text-[var(--text-muted)] italic">{m.requirement}</p>
              <p className="text-sm">{m.evidence}</p>
              {m.caveat ? (
                <p className="caveat text-sm border-l-2 border-[var(--pending)] pl-3 text-[var(--text-muted)]">
                  <span className="font-medium text-[var(--pending)]">Limit: </span>
                  {m.caveat}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {/* ----------------------------------------------------------- retention */}
      <section className="space-y-3">
        <h2 className="font-serif text-lg">Retention</h2>
        <dl className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]">
          <Pin label="Governing rule">
            <span className="font-mono text-xs">{p.retention.policy}</span>
          </Pin>
          <Pin label="Retain until">
            <span className="tabular">{p.retention.retainUntil.slice(0, 10)}</span>
          </Pin>
          <Pin label="Write-once storage">
            <span className={p.retention.wormAnchored ? 'text-[var(--sealed)]' : 'text-[var(--pending)]'}>
              {p.retention.wormAnchored
                ? 'anchored'
                : 'not anchored — the period is recorded but not enforced'}
            </span>
          </Pin>
        </dl>
      </section>

      {/* --------------------------------------------------------------- log */}
      <section className="space-y-3">
        <h2 className="font-serif text-lg">Audit entries</h2>
        <p className="text-sm text-[var(--text-muted)]">
          {p.entries.length} of {p.logSize} entries in the log, each with an inclusion proof
          against root <Digest value={p.logRoot} />.
        </p>
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-[var(--text-muted)] text-xs">
              <tr className="border-b border-[var(--border)]">
                <th className="p-3 font-medium">Seq</th>
                <th className="p-3 font-medium">Action</th>
                <th className="p-3 font-medium">Actor</th>
                <th className="p-3 font-medium">Recorded</th>
                <th className="p-3 font-medium">Entry hash</th>
              </tr>
            </thead>
            <tbody>
              {p.entries.map((e) => (
                <tr key={e.seq} className="border-b border-[var(--border)] last:border-0">
                  <td className="p-3 font-mono tabular">{e.seq}</td>
                  <td className="p-3 font-mono text-xs">{e.action}</td>
                  <td className="p-3">{e.actor}</td>
                  <td className="p-3 tabular text-xs text-[var(--text-muted)]">
                    {e.recordedAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="p-3">
                    <Digest value={e.entryHash} chars={6} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="text-xs text-[var(--text-muted)] border-t border-[var(--border)] pt-4">
        Signed with {bundle.signature.algorithm} by key{' '}
        <span className="font-mono">{bundle.signature.keyId}</span>. Verify independently with the
        public key from <span className="font-mono">/v1/evidence/keys</span>, which requires no
        authentication.
      </footer>
    </article>
  );
}

function Pin({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 p-3">
      <dt className="text-sm text-[var(--text-muted)] shrink-0">{label}</dt>
      <dd className="text-sm text-right break-all">{children}</dd>
    </div>
  );
}
