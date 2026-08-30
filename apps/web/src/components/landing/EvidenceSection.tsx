/**
 * Evidence, audit chain, and reproducibility.
 *
 * The three sections that carry the product's actual claim, so they are the
 * most detailed visuals on the page.
 *
 * Every value shown is the shape the system really produces — ed25519 with a
 * key id, a Merkle root, sequence numbers that start well above zero because a
 * bundle holds one run's entries out of a shared log. The one thing not shown
 * is a firecracker isolation backend, which the brief's example used: that
 * backend is not implemented, and a bundle claiming it would be attesting to
 * an isolation boundary that never existed.
 */

import { BadgeCheck, ChevronRight, FileCheck, Link2 } from 'lucide-react';
import { useState } from 'react';
import {
  IllustrativeTag,
  Panel,
  Reveal,
  Section,
  SectionHeading,
  SectionLabel,
} from './primitives';

const FILES = [
  { name: 'manifest', note: 'What ran, and under what conditions' },
  { name: 'entries', note: "The run's audit records, in order" },
  { name: 'inclusionProofs', note: 'One Merkle proof per entry' },
  { name: 'logRoot', note: 'The tree root these proofs verify against' },
  { name: 'retention', note: 'Governing rule and retain-until date' },
  { name: 'signature', note: 'Ed25519 over the canonical payload' },
] as const;

const DETAIL: Record<string, [string, string][]> = {
  manifest: [
    ['runId', 'run_mtfrc4mv6'],
    ['environment', 'sha256:3f3f…3f3f'],
    ['model', 'ollama/gemma3:4b'],
    ['taskSet', 'smoke@1'],
    ['verifier', 'manual@1'],
    ['isolationBackend', 'model'],
    ['seed', '42'],
  ],
  entries: [
    ['count', '7'],
    ['first seq', '25'],
    ['last seq', '31'],
    ['actor', 'worker-19920'],
  ],
  inclusionProofs: [
    ['proofs', '7'],
    ['treeSize', '32'],
    ['algorithm', 'RFC 6962'],
  ],
  logRoot: [['root', '8fbaa71a1ce456b5…4f7f2e3c']],
  retention: [
    ['policy', 'eu-ai-act-art-19'],
    ['retainUntil', '2027-03-01'],
    ['wormAnchored', 'false'],
  ],
  signature: [
    ['algorithm', 'ed25519'],
    ['keyId', 'dev-key-1'],
    ['signedAt', '2026-08-30T11:59:44Z'],
  ],
};

export function EvidenceSection() {
  const [selected, setSelected] = useState<string>('manifest');

  return (
    <Section>
      <SectionLabel index="04">Evidence</SectionLabel>
      <SectionHeading sub="A bundle is self-contained. It carries the manifest, the entries, a proof for each of them, the root they verify against, and a signature over the whole thing.">
        Don&rsquo;t just trust the result.
        <br />
        Verify the evidence.
      </SectionHeading>

      <Reveal className="mt-12">
        <Panel
          title={
            <>
              <FileCheck className="size-3.5" aria-hidden="true" />
              <span>Evidence bundle</span>
              <span className="normal-case text-[var(--text)]">bundle_mtfrdeep7</span>
            </>
          }
          aside={<IllustrativeTag />}
        >
          <div className="grid md:grid-cols-[minmax(0,240px)_1fr]">
            <ul className="border-b border-[var(--border)] md:border-b-0 md:border-r">
              {FILES.map((file) => {
                const active = selected === file.name;
                return (
                  <li key={file.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(file.name)}
                      aria-pressed={active}
                      className={`flex w-full items-center gap-2 border-b border-[var(--border)] px-4 py-2.5 text-left font-mono text-xs transition-colors duration-150 last:border-b-0 ${
                        active
                          ? 'bg-[var(--surface)] text-[var(--text)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                      }`}
                    >
                      <ChevronRight
                        className={`size-3 shrink-0 transition-transform duration-150 ${
                          active ? 'translate-x-0.5' : 'opacity-40'
                        }`}
                        aria-hidden="true"
                      />
                      {file.name}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="min-w-0 p-5">
              <p className="text-xs text-[var(--text-muted)]">
                {FILES.find((f) => f.name === selected)?.note}
              </p>
              <dl className="mt-4 space-y-0">
                {DETAIL[selected]!.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] py-2 last:border-0"
                  >
                    <dt className="font-mono text-xs text-[var(--text-muted)]">{key}</dt>
                    <dd className="truncate font-mono text-xs">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-4 py-3 text-sm"
            style={{ color: 'var(--sealed)' }}
          >
            <span className="inline-flex items-center gap-2">
              <BadgeCheck className="size-4" aria-hidden="true" />
              Integrity verified
            </span>
            <span className="font-mono text-xs text-[var(--text-muted)]">
              signature · entries · ordering · inclusion · manifest
            </span>
          </div>
        </Panel>
      </Reveal>
    </Section>
  );
}

const CHAIN = [
  { seq: 25, at: '08:05:48', action: 'run.started', actor: 'you@example.test' },
  { seq: 26, at: '08:05:49', action: 'run.claimed', actor: 'worker-19920' },
  { seq: 27, at: '08:06:02', action: 'model.request', actor: 'worker-19920' },
  { seq: 28, at: '08:06:11', action: 'model.response', actor: 'worker-19920' },
  { seq: 29, at: '08:06:13', action: 'run.completed', actor: 'worker-19920' },
] as const;

export function AuditSection() {
  return (
    <Section>
      <SectionLabel index="05">Audit</SectionLabel>
      <SectionHeading sub="Each entry carries the hash of the one before it. Altering an entry changes its own digest; removing one breaks the link at that point. Both are detectable by anyone holding the bundle.">
        Every important action leaves a trace.
      </SectionHeading>

      <Reveal className="mt-12">
        <Panel
          title={
            <>
              <Link2 className="size-3.5" aria-hidden="true" />
              <span>Audit log</span>
              <span className="normal-case text-[var(--text)]">run_mtfrc4mv6</span>
            </>
          }
          aside={<IllustrativeTag />}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {['seq', 'time', 'action', 'actor', 'entryHash'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="px-4 py-2 font-mono text-[10px] font-normal uppercase tracking-wider text-[var(--text-muted)]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CHAIN.map((entry) => (
                  <tr key={entry.seq} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs tabular text-[var(--text-muted)]">
                      {entry.seq}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular text-[var(--text-muted)]">
                      {entry.at}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{entry.action}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-muted)]">
                      {entry.actor}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-muted)]">
                      {`${(entry.seq * 7919).toString(16).padStart(6, '0')}…`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-[var(--border)] p-5">
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              <span className="rounded border border-[var(--border)] px-2 py-1">
                entry 27 · previousHash
              </span>
              <span aria-hidden="true" className="text-[var(--text-muted)]">
                →
              </span>
              <span className="rounded border border-[var(--border)] px-2 py-1">
                entry 28 · entryHash
              </span>
              <span aria-hidden="true" className="text-[var(--text-muted)]">
                →
              </span>
              <span className="rounded border border-[var(--border)] px-2 py-1">
                entry 29 · previousHash
              </span>
            </div>
            <p className="mt-3 text-sm text-[var(--text-muted)]">
              Append-only and hash-linked, so an unauthorised change is detectable without
              consulting the system that wrote the record.
            </p>
          </div>
        </Panel>
      </Reveal>
    </Section>
  );
}

const CONFIG: [string, string][] = [
  ['Model', 'ollama/gemma3:4b'],
  ['Environment', 'local/ollama'],
  ['Image digest', 'sha256:3f3f…3f3f'],
  ['Task set', 'smoke @ 1'],
  ['Verifier', 'manual @ 1'],
  ['Isolation backend', 'model'],
  ['Seed', '42'],
  ['Temperature', '0'],
  ['Toolchain', 'agent-eval 1.0.0'],
];

export function ReproducibilitySection() {
  return (
    <Section>
      <SectionLabel index="06">Reproducibility</SectionLabel>
      <SectionHeading sub="A result is only meaningful when the conditions that produced it can be reconstructed. Every field below is written into the manifest and hashed into the bundle.">
        Know exactly what produced the result.
      </SectionHeading>

      <Reveal className="mt-12">
        <Panel
          title={
            <>
              <span>Run manifest</span>
              <span className="normal-case text-[var(--text)]">run_mtfrc4mv6</span>
            </>
          }
          aside={
            <span className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                style={{ borderColor: 'var(--sealed)', color: 'var(--sealed)' }}
              >
                <BadgeCheck className="size-3" aria-hidden="true" />
                Reproducible
              </span>
              <IllustrativeTag />
            </span>
          }
        >
          <dl className="grid gap-px bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
            {CONFIG.map(([key, value]) => (
              <div
                key={key}
                className="bg-[var(--surface-raised)] p-4 transition-colors duration-150 hover:bg-[var(--surface)]"
              >
                <dt className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {key}
                </dt>
                <dd className="mt-1.5 truncate font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </Reveal>
    </Section>
  );
}
