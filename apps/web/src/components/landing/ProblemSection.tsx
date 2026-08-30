/**
 * The problem, and the pipeline that answers it.
 *
 * Two sections in one file because they are one argument: a score is a single
 * layer, and the pipeline is what produces the layers underneath it.
 */

import {
  Bot,
  Box,
  FileCheck,
  Link2,
  Route,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { Reveal, Section, SectionHeading, SectionLabel } from './primitives';

const LAYERS = [
  'Environment digest',
  'Model and sampling',
  'Task set and version',
  'Hash-chained audit trail',
  'Signed evidence bundle',
  'Independent verification',
] as const;

export function ProblemSection() {
  return (
    <Section id="product">
      <SectionLabel index="01">The problem</SectionLabel>
      <SectionHeading
        sub="A number tells you the outcome. It cannot tell you which model produced it, against which task set version, under which sampling settings, or whether the record has been edited since."
      >
        A score tells you what happened.
        <br />
        Evidence tells you why.
      </SectionHeading>

      <div className="mt-12 grid gap-5 md:grid-cols-2">
        <Reveal>
          <div className="flex h-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6">
            <p className="font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
              Traditional evaluation
            </p>
            <p className="mt-6 font-serif text-[44px] leading-none tabular">82%</p>
            <p className="mt-2 text-sm text-[var(--text-muted)]">Pass</p>
            <p className="mt-auto border-t border-[var(--border)] pt-4 text-sm text-[var(--text-muted)]">
              Reproducible only if someone wrote down the conditions somewhere else.
            </p>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="h-full rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6">
            <p className="font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
              agent-eval
            </p>
            <p className="mt-6 font-serif text-[44px] leading-none tabular">82%</p>
            <p className="mt-2 text-sm text-[var(--text-muted)]">Pass</p>

            <ul className="mt-6 space-y-0 border-t border-[var(--border)]">
              {LAYERS.map((layer, i) => (
                <li
                  key={layer}
                  className="flex items-center gap-2.5 border-b border-[var(--border)] py-2 text-sm last:border-0"
                >
                  <span
                    className="inline-block size-1.5 shrink-0 rounded-full"
                    style={{ background: 'var(--sealed)' }}
                    aria-hidden="true"
                  />
                  <span className="text-[var(--text-muted)]">{layer}</span>
                  <span className="sr-only">, included</span>
                  <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

interface Stage {
  Icon: LucideIcon;
  title: string;
  detail: string;
}

/**
 * The stages are the real ones. There is no "trajectory capture" node, because
 * trajectory capture is not implemented — the audit log is what the platform
 * actually records, and putting a stage here that does not exist would be the
 * exact failure this product is built to prevent.
 */
const STAGES: Stage[] = [
  { Icon: Bot, title: 'Agent', detail: 'A run is queued with a manifest describing what to execute.' },
  { Icon: Box, title: 'Environment', detail: 'Pinned by digest, so the conditions can be recreated.' },
  { Icon: Route, title: 'Execution', detail: 'A worker claims the run and calls the model provider.' },
  { Icon: Link2, title: 'Audit log', detail: 'Every state change appended and hash-chained.' },
  { Icon: FileCheck, title: 'Evidence', detail: 'A signed bundle with an inclusion proof per entry.' },
  { Icon: ShieldCheck, title: 'Verification', detail: 'Checked offline against a public key.' },
];

export function PipelineSection() {
  return (
    <Section id="how-it-works">
      <SectionLabel index="02">How it works</SectionLabel>
      <SectionHeading sub="Each stage adds something the next one depends on. The last stage needs none of this system to run.">
        From agent run to verifiable evidence.
      </SectionHeading>

      {/* Horizontal on wide screens, vertical on narrow — a genuinely different
          arrangement rather than the same row squeezed. */}
      <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-6">
        {STAGES.map((stage, i) => (
          <Reveal as="li" key={stage.title} delay={i * 70}>
            <div className="group h-full bg-[var(--surface-raised)] p-5 transition-colors duration-200 hover:bg-[var(--surface)]">
              <div className="flex items-center justify-between">
                <stage.Icon
                  className="size-[18px] text-[var(--text-muted)] transition-transform duration-200 group-hover:-translate-y-0.5"
                  aria-hidden="true"
                />
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
              <p className="mt-3 text-sm font-medium">{stage.title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-muted)]">
                {stage.detail}
              </p>
            </div>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}
