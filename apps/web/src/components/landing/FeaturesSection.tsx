/**
 * Features.
 *
 * A connected grid rather than six floating cards: the borders meet, which
 * reads as one specification table instead of six separate advertisements.
 *
 * The wording here was checked against the implementation, and two of the
 * features the brief proposed are not in this build. "Complete trajectories"
 * is not — no trajectory capture exists anywhere in the codebase — so the
 * card describes the audit trail, which does. "Policy-aware evaluation" is
 * not either: there are Rego policy files in the repository, but no code
 * evaluates them, so it would have described a directory rather than a
 * feature. What replaced it is retention, which is enforced.
 */

import {
  Fingerprint,
  KeyRound,
  Link2,
  ScrollText,
  ShieldCheck,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { Reveal, Section, SectionHeading, SectionLabel } from './primitives';

interface Feature {
  Icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    Icon: Fingerprint,
    title: 'Reproducible runs',
    body: 'Every run records its environment digest, task set version, verifier version, model, sampling and seed. A manifest that could not be reproduced is rejected at submission rather than after execution.',
  },
  {
    Icon: ScrollText,
    title: 'Complete audit trail',
    body: 'Every state change — queued, claimed, requested, answered, verified, completed — is appended in order with its actor and timestamp.',
  },
  {
    Icon: Link2,
    title: 'Tamper-evident logs',
    body: 'Entries are hash-chained and committed to an RFC 6962 Merkle tree. Altering one is detectable; removing one is detectable.',
  },
  {
    Icon: ShieldCheck,
    title: 'Verifiable evidence',
    body: 'Bundles are signed with Ed25519 and carry an inclusion proof for every entry, so they can be checked with a public key and nothing else.',
  },
  {
    Icon: KeyRound,
    title: 'Encrypted credentials',
    body: 'Provider keys are sealed with AES-256-GCM, bound to their tenant, and never returned by any endpoint. The browser never holds one.',
  },
  {
    Icon: Timer,
    title: 'Retention that resolves',
    body: 'Runs declare a legal basis. Where several apply the longest floor governs, and a bundle below its floor is refused rather than signed.',
  },
];

export function FeaturesSection() {
  return (
    <Section>
      <SectionLabel index="03">Capabilities</SectionLabel>
      <SectionHeading sub="Six properties the platform actually enforces. Each one fails loudly rather than degrading quietly.">
        Everything needed to evaluate agents with confidence.
      </SectionHeading>

      <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, i) => (
          <Reveal key={feature.title} delay={(i % 3) * 80}>
            <article className="group h-full bg-[var(--surface-raised)] p-6 transition-colors duration-200 hover:bg-[var(--surface)]">
              <feature.Icon
                className="size-5 text-[var(--text-muted)] transition-transform duration-200 group-hover:-translate-y-0.5"
                aria-hidden="true"
              />
              <h3 className="mt-4 text-sm font-medium">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">{feature.body}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
