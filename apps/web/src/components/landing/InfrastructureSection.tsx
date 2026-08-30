/**
 * Self-hosting, architecture, and security.
 *
 * The architecture diagram is built from borders and grid cells rather than an
 * SVG, so it reflows on a narrow screen into a vertical stack instead of
 * becoming a horizontally-scrolling picture of itself.
 *
 * The security list contains only mechanisms that exist in the codebase. Two
 * things the brief suggested are absent and stay absent: "credential
 * brokering" is part of the unbuilt isolation layer, and "immutable evidence"
 * would be an overstatement — the log is tamper-*evident*, which is a
 * different and honest claim.
 */

import {
  Database,
  FileCheck,
  Fingerprint,
  KeyRound,
  Link2,
  Lock,
  ScrollText,
  Server,
  ShieldCheck,
  Terminal,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { Reveal, Section, SectionHeading, SectionLabel } from './primitives';

const LAYERS: { label: string; detail: string; Icon: LucideIcon }[] = [
  { label: 'CLI · SDK · Dashboard', detail: 'Callers, each scoped by credential', Icon: Terminal },
  { label: 'Control plane API', detail: 'Fastify, Zod-validated, problem+json', Icon: Server },
  { label: 'Run worker', detail: 'Claims atomically, executes, records', Icon: Database },
  { label: 'Provider adapters', detail: 'Nine, behind one normalized shape', Icon: Link2 },
  { label: 'Audit log', detail: 'Hash-chained, Merkle-committed', Icon: ScrollText },
  { label: 'Evidence + verification', detail: 'Signed bundles, checkable offline', Icon: FileCheck },
];

export function ArchitectureSection() {
  return (
    <Section>
      <SectionLabel index="11">Architecture</SectionLabel>
      <SectionHeading sub="Every caller enters through one API, and every run leaves one trail. There is no second path that writes evidence.">
        One execution layer.
        <br />
        One evidence trail.
      </SectionHeading>

      <ol className="mt-12 space-y-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)]">
        {LAYERS.map((layer, i) => (
          <Reveal as="li" key={layer.label} delay={i * 60}>
            <div className="flex items-center gap-4 bg-[var(--surface-raised)] px-5 py-4 transition-colors duration-200 hover:bg-[var(--surface)]">
              <span className="font-mono text-[10px] tabular text-[var(--text-muted)]">
                {String(i + 1).padStart(2, '0')}
              </span>
              <layer.Icon className="size-[18px] shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{layer.label}</p>
              </div>
              <p className="hidden text-xs text-[var(--text-muted)] sm:block">{layer.detail}</p>
            </div>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}

export function SelfHostedSection() {
  return (
    <Section>
      <SectionLabel index="09">Deployment</SectionLabel>
      <SectionHeading sub="Evaluation traces contain prompts, model outputs and often customer data. Sending them to a vendor in order to prove compliance is a strange way to comply.">
        Your evaluations.
        <br />
        Your infrastructure.
      </SectionHeading>

      <div className="mt-12 grid gap-5 lg:grid-cols-[1fr_minmax(0,420px)]">
        <Reveal>
          <ul className="grid h-full gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
            {[
              ['Execution data', 'Never leaves your network.'],
              ['Audit logs', 'Written and read where you run them.'],
              ['Evidence bundles', 'Signed by a key you hold.'],
              ['Provider credentials', 'Encrypted with a key only you have.'],
            ].map(([title, body]) => (
              <li key={title} className="bg-[var(--surface-raised)] p-5">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1.5 text-sm text-[var(--text-muted)]">{body}</p>
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={100}>
          <div className="h-full rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Your infrastructure
            </p>
            <div className="mt-4 rounded-lg border border-[var(--border)] p-4">
              <p className="font-mono text-xs">agent-eval</p>
              <ul className="mt-3 space-y-1.5 font-mono text-xs text-[var(--text-muted)]">
                <li>API</li>
                <li>Worker</li>
                <li>Audit log</li>
                <li>Evidence + verification</li>
              </ul>
            </div>
            <p aria-hidden="true" className="my-2 text-center text-[var(--text-muted)]">
              ↓
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-center font-mono text-xs text-[var(--text-muted)]">
                Model providers
              </div>
              <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-center font-mono text-xs text-[var(--text-muted)]">
                Execution
              </div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-[var(--text-muted)]">
              The only traffic that leaves is the provider calls you configure, carrying what your
              task set contains.
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

const SECURITY: { Icon: LucideIcon; title: string; body: string }[] = [
  {
    Icon: KeyRound,
    title: 'Credential encryption',
    body: 'AES-256-GCM, keyed only from the environment. No default key exists, so a deployment that has not configured one refuses to store secrets rather than writing them in plaintext.',
  },
  {
    Icon: Lock,
    title: 'Tenant-bound ciphertext',
    body: 'GCM associated data binds each secret to its tenant and record. A row copied between tenants will not decrypt.',
  },
  {
    Icon: ShieldCheck,
    title: 'Scoped authorization',
    body: 'Seven scopes, checked per route. A key cannot be minted with scopes its creator does not hold.',
  },
  {
    Icon: Link2,
    title: 'Tamper-evident records',
    body: 'Hash-chained entries committed to a Merkle tree. Alteration and removal are both detectable — the log is evident, not immutable, and the distinction is deliberate.',
  },
  {
    Icon: Fingerprint,
    title: 'Environment pinning',
    body: 'Runs record a digest rather than a tag, because a tag can move and the run would no longer be re-creatable.',
  },
  {
    Icon: Timer,
    title: 'Retention enforcement',
    body: 'A bundle whose retention falls below its governing floor is refused rather than signed.',
  },
];

export function SecuritySection() {
  return (
    <Section>
      <SectionLabel index="12">Security</SectionLabel>
      <SectionHeading sub="Each of these is implemented and covered by tests. Mechanisms that are designed but not built — the VM isolation backends and their egress control — are listed as absent in the documentation rather than implied here.">
        Security is part of the execution model.
      </SectionHeading>

      <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
        {SECURITY.map((item, i) => (
          <Reveal key={item.title} delay={(i % 3) * 70}>
            <article className="group h-full bg-[var(--surface-raised)] p-6 transition-colors duration-200 hover:bg-[var(--surface)]">
              <item.Icon
                className="size-5 text-[var(--text-muted)] transition-transform duration-200 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
              <h3 className="mt-4 text-sm font-medium">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{item.body}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
