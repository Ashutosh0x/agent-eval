/**
 * Hero.
 *
 * The right-hand panel is the argument the page is making, so it is a real
 * interface rather than an illustration: a run, its audit entries appearing in
 * order, the environment digest, and a verification result. It uses the same
 * tokens, the same monospace, and the same seal vocabulary as the dashboard,
 * because a visitor should recognise the product when they reach it.
 *
 * The sequence advances on a timer and stops when it completes. It does not
 * loop indefinitely: a panel that keeps replaying draws the eye away from the
 * text for as long as the reader stays, and the point is made once.
 */

import { ArrowRight, BadgeCheck, Github } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GITHUB_URL,
  GridBackground,
  IllustrativeTag,
  Panel,
  primaryButton,
  secondaryButton,
} from './primitives';

/**
 * The shape of a real run's audit trail. These action names are the ones the
 * worker actually appends — run.started, run.claimed, model.request,
 * model.response, run.completed — so the panel teaches the reader something
 * true about the system rather than a plausible-looking invention.
 */
const EVENTS = [
  { at: '08:05:48', action: 'run.started' },
  { at: '08:05:49', action: 'run.claimed' },
  { at: '08:06:02', action: 'model.request' },
  { at: '08:06:11', action: 'model.response' },
  { at: '08:06:13', action: 'run.completed' },
] as const;

export function Hero() {
  return (
    <div className="relative overflow-hidden">
      <GridBackground />

      <div className="relative mx-auto grid max-w-[1200px] items-center gap-14 px-6 pb-20 pt-16 sm:px-8 md:pb-28 md:pt-24 lg:grid-cols-[1.15fr_1fr] lg:gap-14 lg:px-10">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">
            Agent evaluation infrastructure
          </p>

          <h1 className="mt-5 font-serif text-[42px] font-medium leading-[1.08] tracking-tight sm:text-[52px] lg:text-[56px]">
            Evaluate AI agents.
            <br />
            <span className="text-[var(--text-muted)]">Prove what happened.</span>
          </h1>

          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-[var(--text-muted)]">
            Run agents against model providers, capture every state change in a hash-chained log,
            and generate signed evidence a reviewer can verify without trusting the server that
            produced it.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/signin" className={primaryButton + ' group'}>
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
              className={secondaryButton}
            >
              <Github className="size-4" aria-hidden="true" />
              View on GitHub
            </a>
          </div>

          <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
            <span>Self-hosted</span>
            <span aria-hidden="true" className="opacity-40">
              ·
            </span>
            <span>Open source</span>
            <span aria-hidden="true" className="opacity-40">
              ·
            </span>
            <span>Provider agnostic</span>
          </p>
        </div>

        <RunPanel />
      </div>
    </div>
  );
}

function RunPanel() {
  // How many events have appeared. Starts complete for reduced motion, so the
  // panel is never a half-drawn thing for someone who asked for stillness.
  const reduced =
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const [step, setStep] = useState(reduced ? EVENTS.length : 0);

  useEffect(() => {
    if (step >= EVENTS.length) return;
    const timer = setTimeout(() => setStep((s) => s + 1), step === 0 ? 500 : 900);
    return () => clearTimeout(timer);
  }, [step]);

  const done = step >= EVENTS.length;

  return (
    <Panel
      className="lg:justify-self-end lg:max-w-[480px]"
      title={
        <>
          <span>Run</span>
          <span className="normal-case text-[var(--text)]">run_mtfrc4mv6</span>
        </>
      }
      aside={<IllustrativeTag />}
    >
      <div className="px-4 py-4">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`inline-block size-1.5 rounded-full ${done ? '' : 'animate-pulse'}`}
            style={{ background: done ? 'var(--sealed)' : 'var(--pending)' }}
            aria-hidden="true"
          />
          <span className="font-mono uppercase tracking-wider text-[var(--text-muted)]">
            {done ? 'Completed' : 'Running'}
          </span>
        </div>

        <ol className="mt-4 space-y-0">
          {EVENTS.map((event, i) => {
            const visible = i < step;
            return (
              <li
                key={event.action}
                className={`flex items-baseline gap-3 border-b border-[var(--border)] py-2 font-mono text-xs last:border-0 transition-[opacity,transform] duration-500 ${
                  visible ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
                }`}
              >
                <span className="tabular text-[var(--text-muted)]">{event.at}</span>
                <span>{event.action}</span>
              </li>
            );
          })}
        </ol>

        <dl className="mt-4 space-y-2 border-t border-[var(--border)] pt-4 text-xs">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="font-mono uppercase tracking-wider text-[var(--text-muted)]">
              Environment
            </dt>
            <dd className="truncate font-mono">sha256:3f3f3f3f…3f3f</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="font-mono uppercase tracking-wider text-[var(--text-muted)]">Model</dt>
            <dd className="truncate font-mono">ollama/gemma3:4b</dd>
          </div>
        </dl>
      </div>

      <div
        className={`flex items-center gap-2 border-t border-[var(--border)] px-4 py-3 text-sm transition-opacity duration-700 ${
          done ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ color: 'var(--sealed)' }}
      >
        <BadgeCheck className="size-4" aria-hidden="true" />
        Evidence bundle signed and verified
      </div>
    </Panel>
  );
}
