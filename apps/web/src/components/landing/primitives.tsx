/**
 * Shared building blocks for the landing page.
 *
 * These exist so the page can be assembled from small files rather than one
 * enormous component, and so the spacing, labelling and reveal behaviour are
 * decided once. Everything draws on the tokens the dashboard already defines
 * (--surface, --text, --border, --sealed) — there is no second palette here,
 * because a marketing page in a different visual language would be advertising
 * a product the user does not then receive.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

export const GITHUB_URL = 'https://github.com/Ashutosh0x/agent-eval';

/**
 * True when the visitor has asked for less motion.
 *
 * The global stylesheet already collapses animation and transition durations
 * under prefers-reduced-motion, but that is not sufficient here: a reveal that
 * starts at opacity 0 and depends on a transition would simply snap, and any
 * element whose observer never fires would stay invisible. So motion is
 * skipped at the source instead — the content renders in its final state.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * Reveals children once they enter the viewport.
 *
 * Defaults to visible rather than hidden. An IntersectionObserver that never
 * fires — because the environment lacks one, or the element is inside a
 * container the observer cannot see — must leave the content readable. A
 * landing page that renders blank in an unusual browser is worse than one that
 * never animates.
 */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'article';
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(() => reduced || typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (shown) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      // A little before the element arrives, so the motion finishes about when
      // the reader's eye does.
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);

  return (
    <Tag
      ref={ref as never}
      className={`${className} ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
      } transition-[opacity,transform] duration-700 ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100`}
      style={shown && delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}

/**
 * A numbered section label, as in a specification document.
 *
 * The numbering is the point: it frames the page as a technical document
 * rather than a sales deck, which is the register this product should speak in.
 */
export function SectionLabel({ index, children }: { index: string; children: ReactNode }) {
  return (
    <p className="mb-4 font-mono text-xs uppercase tracking-[0.14em] text-[var(--text-muted)]">
      <span className="text-[var(--text)]">{index}</span>
      <span className="mx-2 opacity-40">/</span>
      {children}
    </p>
  );
}

/** Consistent vertical rhythm and a max width that keeps prose readable. */
export function Section({
  id,
  children,
  className = '',
  bordered = true,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  bordered?: boolean;
}) {
  return (
    <section
      id={id}
      // scroll-mt clears the sticky header when a nav link jumps here.
      className={`scroll-mt-20 ${bordered ? 'border-t border-[var(--border)]' : ''} ${className}`}
    >
      <div className="mx-auto max-w-[1200px] px-6 py-20 sm:px-8 md:py-28 lg:px-10">{children}</div>
    </section>
  );
}

export function SectionHeading({
  children,
  sub,
}: {
  children: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <>
      <h2 className="max-w-2xl font-serif text-[28px] leading-[1.2] tracking-tight sm:text-[34px]">
        {children}
      </h2>
      {sub ? (
        <p className="mt-4 max-w-2xl leading-relaxed text-[var(--text-muted)]">{sub}</p>
      ) : null}
    </>
  );
}

/**
 * A faint engineering grid.
 *
 * Kept at very low contrast and marked aria-hidden — it is texture, and a
 * screen reader announcing it would be noise. Drawn with a gradient rather
 * than an image so it costs nothing to load and adapts to both themes.
 */
export function GridBackground({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <div
        className="absolute inset-0 opacity-[0.55] dark:opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--border) 1px, transparent 1px),' +
            'linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          // Fades out before it reaches the text, so the grid never competes
          // with anything that has to be read.
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, #000 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, #000 20%, transparent 75%)',
        }}
      />
    </div>
  );
}

/** Shared button shapes. Real elements: <a> for navigation, <button> for actions. */
export const primaryButton =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--text)] px-5 text-sm font-medium text-[var(--surface)] transition-all duration-150 hover:-translate-y-px hover:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] active:translate-y-0 active:scale-[0.985]';

export const secondaryButton =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-5 text-sm font-medium transition-all duration-150 hover:border-[var(--text-muted)] hover:-translate-y-px active:translate-y-0 active:scale-[0.985]';

/**
 * Marks a panel as illustrative.
 *
 * Every product visual on this page is a static example, and several of them
 * look convincingly like live output. Labelling them is not a formality: an
 * unlabelled panel showing a signed bundle and a passing verification is a
 * claim about a run that never happened.
 */
export function IllustrativeTag({ className = '' }: { className?: string }) {
  return (
    <span
      className={`rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] ${className}`}
    >
      Illustrative
    </span>
  );
}

/** A window frame that matches the dashboard's own surfaces. */
export function Panel({
  title,
  aside,
  children,
  className = '',
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] shadow-[0_16px_40px_-24px_rgba(0,0,0,0.35)] ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2.5">
        {/* uppercase applies to the label; identifiers below opt out with
            normal-case, because run_mtfrc4mv6 is not RUN_MTFRC4MV6. */}
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs uppercase tracking-wider text-[var(--text-muted)]">
          {title}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}
