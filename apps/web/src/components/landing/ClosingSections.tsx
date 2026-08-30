/**
 * Open source, documentation, the final call to action, and the footer.
 *
 * Two absences here are deliberate. There are no star or fork counts: they
 * would either be invented or require an unauthenticated call to GitHub on
 * every page load, and a number nobody verified is exactly the kind of claim
 * this product exists to argue against. And there is one social link, because
 * one social account exists — the repository. No X, LinkedIn or Discord URL
 * appears anywhere in the README, package metadata or documentation, so none
 * is shown.
 */

import { ArrowRight, BookOpen, Github } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  GITHUB_URL,
  GridBackground,
  Reveal,
  Section,
  SectionHeading,
  SectionLabel,
  primaryButton,
  secondaryButton,
} from './primitives';

export function OpenSourceSection() {
  return (
    <Section>
      <SectionLabel index="13">Open source</SectionLabel>
      <SectionHeading sub="The evidence layer is the product, so it is the part most worth reading. The Merkle implementation, the hash chain, the canonicalization and the verifier are all in the repository, along with the tests that hold them.">
        Built in the open.
      </SectionHeading>

      <Reveal className="mt-10">
        <div className="flex flex-col items-start justify-between gap-6 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6 sm:flex-row sm:items-center">
          <div>
            <p className="flex items-center gap-2 font-mono text-sm">
              <Github className="size-4" aria-hidden="true" />
              Ashutosh0x/agent-eval
            </p>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {['Open source', 'Self-hosted', 'TypeScript'].map((tag) => (
                <li
                  key={tag}
                  className="rounded border border-[var(--border)] px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]"
                >
                  {tag}
                </li>
              ))}
            </ul>
          </div>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={secondaryButton + ' group shrink-0'}
          >
            View source
            <ArrowRight
              className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </a>
        </div>
      </Reveal>
    </Section>
  );
}

export function DocsCta() {
  return (
    <Section>
      <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
        <div>
          <SectionHeading sub="Start with the documentation, connect a provider, and run an evaluation in your own environment.">
            Ready to run your first evaluation?
          </SectionHeading>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <Link to="/docs" className={secondaryButton}>
            <BookOpen className="size-4" aria-hidden="true" />
            Read the docs
          </Link>
          <Link to="/signin" className={primaryButton + ' group'}>
            Get started
            <ArrowRight
              className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
      </div>
    </Section>
  );
}

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-[var(--border)] bg-[var(--text)] text-[var(--surface)] dark:bg-[var(--surface-raised)] dark:text-[var(--text)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, currentColor 1px, transparent 1px),' +
            'linear-gradient(to bottom, currentColor 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />
      <div className="relative mx-auto max-w-[1200px] px-6 py-24 text-center sm:px-8 md:py-32 lg:px-10">
        <h2 className="font-serif text-[36px] leading-[1.15] tracking-tight sm:text-[48px]">
          Evaluate. Capture. Verify.
        </h2>
        <p className="mx-auto mt-5 max-w-xl leading-relaxed opacity-70">
          Build evaluation workflows where the result is backed by evidence somebody else can check.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link
            to="/signin"
            className="group inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--surface)] px-5 text-sm font-medium text-[var(--text)] transition-all duration-150 hover:-translate-y-px active:translate-y-0 active:scale-[0.985] dark:bg-[var(--text)] dark:text-[var(--surface)]"
          >
            Get started
            <ArrowRight
              className="size-4 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-current/25 px-5 text-sm font-medium opacity-80 transition-all duration-150 hover:opacity-100 active:scale-[0.985]"
          >
            <Github className="size-4" aria-hidden="true" />
            View GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

const FOOTER_GROUPS: { title: string; links: { label: string; to: string; external?: boolean }[] }[] =
  [
    {
      title: 'Product',
      links: [
        { label: 'How it works', to: '#how-it-works' },
        { label: 'Capabilities', to: '#product' },
        { label: 'Documentation', to: '/docs' },
      ],
    },
    {
      title: 'Developers',
      links: [
        { label: 'Getting started', to: '/docs/quick-start' },
        { label: 'REST API', to: '/docs/rest-api' },
        { label: 'TypeScript SDK', to: '/docs/sdk' },
        { label: 'CLI', to: '/docs/cli' },
      ],
    },
    {
      title: 'Reference',
      links: [
        { label: 'Providers', to: '/docs/provider-list' },
        { label: 'Configuration', to: '/docs/environment' },
        { label: 'Limits', to: '/docs/not-implemented' },
        { label: 'Repository', to: GITHUB_URL, external: true },
      ],
    },
  ];

export function LandingFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-[var(--border)]">
      <GridBackground className="opacity-40" />
      <div className="relative mx-auto max-w-[1200px] px-6 py-14 sm:px-8 lg:px-10">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <p className="flex items-baseline gap-1.5 font-serif text-[17px]">
              agent-eval
              <span aria-hidden="true" className="font-mono text-xs text-[var(--text-muted)]">
                //
              </span>
            </p>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-[var(--text-muted)]">
              Evidence infrastructure for AI agent evaluation.
            </p>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="agent-eval on GitHub"
              title="GitHub"
              className="mt-5 inline-grid size-9 place-items-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors duration-150 hover:border-[var(--text-muted)] hover:text-[var(--text)]"
            >
              <Github className="size-4" aria-hidden="true" />
            </a>
          </div>

          {FOOTER_GROUPS.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                {group.title}
              </p>
              <ul className="mt-3 space-y-2">
                {group.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.to}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-sm text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
                      >
                        {link.label}
                      </a>
                    ) : link.to.startsWith('#') ? (
                      <a
                        href={link.to}
                        className="text-sm text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        to={link.to}
                        className="text-sm text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-2 border-t border-[var(--border)] pt-6 text-xs text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} agent-eval · Open source</p>
          <p className="font-mono">Self-hosted · Provider agnostic · Verifiable evidence</p>
        </div>
      </div>
    </footer>
  );
}
