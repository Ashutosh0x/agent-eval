/**
 * The public landing page.
 *
 * Composed from small section components rather than written as one file, so
 * that each section's claims can be reviewed against the implementation
 * independently — which is how several of them came to be reworded.
 *
 * The page is public: it renders without a token, and its only authenticated
 * affordance is that the navigation offers "Open dashboard" instead of "Sign
 * in" when one is present.
 */

import { useEffect } from 'react';
import { Hero } from '../components/landing/Hero';
import { LandingNav } from '../components/landing/LandingNav';
import {
  DocsCta,
  FinalCta,
  LandingFooter,
  OpenSourceSection,
} from '../components/landing/ClosingSections';
import { DeveloperSection } from '../components/landing/DeveloperSection';
import {
  AuditSection,
  EvidenceSection,
  ReproducibilitySection,
} from '../components/landing/EvidenceSection';
import { FeaturesSection } from '../components/landing/FeaturesSection';
import {
  ArchitectureSection,
  SecuritySection,
  SelfHostedSection,
} from '../components/landing/InfrastructureSection';
import { PipelineSection, ProblemSection } from '../components/landing/ProblemSection';
import { LocalComputeSection, ProvidersSection } from '../components/landing/ProvidersSection';

const TITLE = 'agent-eval — Evaluate AI agents. Prove what happened.';
const DESCRIPTION =
  'Self-hosted infrastructure for evaluating AI agents with hash-chained audit trails, ' +
  'signed evidence bundles that verify offline, and reproducible run manifests.';

/**
 * Page metadata.
 *
 * Set from the component rather than index.html because the dashboard routes
 * share that document, and a static title claiming a marketing headline would
 * follow an authenticated user around their own audit log. Cleaned up on
 * unmount for the same reason.
 */
function useLandingMeta() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = TITLE;

    const tags: HTMLMetaElement[] = [];
    const add = (attr: 'name' | 'property', key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      if (el) {
        // An existing tag is left alone on unmount; only ones added here are
        // removed, so we do not strip metadata another page relies on.
        el.setAttribute('content', content);
        return;
      }
      el = document.createElement('meta');
      el.setAttribute(attr, key);
      el.setAttribute('content', content);
      document.head.appendChild(el);
      tags.push(el);
    };

    add('name', 'description', DESCRIPTION);
    add('property', 'og:title', TITLE);
    add('property', 'og:description', DESCRIPTION);
    add('property', 'og:type', 'website');
    add('property', 'og:site_name', 'agent-eval');
    add('name', 'twitter:card', 'summary_large_image');
    add('name', 'twitter:title', TITLE);
    add('name', 'twitter:description', DESCRIPTION);

    return () => {
      document.title = previousTitle;
      for (const tag of tags) tag.remove();
    };
  }, []);
}

const CAPABILITIES = [
  'Self-hosted',
  'Open source',
  'Provider agnostic',
  'Verifiable evidence',
  'Reproducible runs',
] as const;

function TrustStrip() {
  return (
    <div className="border-y border-[var(--border)] bg-[var(--surface-raised)]">
      <div className="mx-auto max-w-[1200px] px-6 py-6 sm:px-8 lg:px-10">
        <p className="text-sm text-[var(--text-muted)]">
          Built for teams that need evidence, not just an evaluation score.
        </p>
        <ul className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {CAPABILITIES.map((item, i) => (
            <li key={item} className="flex items-center gap-3">
              {i > 0 ? (
                <span aria-hidden="true" className="opacity-30">
                  ·
                </span>
              ) : null}
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function LandingPage({ authenticated }: { authenticated: boolean }) {
  useLandingMeta();

  return (
    // scroll-smooth here rather than globally: the dashboard has its own
    // scrolling behaviour and should not inherit this.
    <div className="scroll-smooth motion-reduce:scroll-auto">
      <LandingNav authenticated={authenticated} />
      <main>
        <Hero />
        <TrustStrip />
        <ProblemSection />
        <PipelineSection />
        <FeaturesSection />
        <EvidenceSection />
        <AuditSection />
        <ReproducibilitySection />
        <ProvidersSection />
        <LocalComputeSection />
        <SelfHostedSection />
        <DeveloperSection />
        <ArchitectureSection />
        <SecuritySection />
        <OpenSourceSection />
        <DocsCta />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
