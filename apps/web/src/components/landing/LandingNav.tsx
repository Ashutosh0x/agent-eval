/**
 * Landing navigation.
 *
 * The mobile menu is a real menu, not the desktop nav with a media query. It
 * traps nothing it should not, closes on Escape and on selection, restores
 * focus to the button that opened it, and locks the background from scrolling
 * while open. Those are the behaviours that separate a menu from a div that
 * appears.
 *
 * The bar is transparent at the top of the page and gains a border and a blur
 * once the reader has moved past the hero — so it stays out of the way until
 * it is needed, then becomes legible against whatever is behind it.
 */

import { Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { GITHUB_URL, primaryButton } from './primitives';

interface NavItem {
  label: string;
  href: string;
  external?: boolean;
  route?: boolean;
}

/**
 * Every destination here resolves to something that exists: two in-page
 * sections, the documentation route built into this app, and the repository
 * from the git remote. Nothing points at "#".
 */
const NAV_ITEMS: NavItem[] = [
  { label: 'Product', href: '#product' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'Documentation', href: '/docs', route: true },
  { label: 'GitHub', href: GITHUB_URL, external: true },
];

export function LandingNav({ authenticated }: { authenticated: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        // Focus goes back where it came from, or the reader is left adrift at
        // the top of the document.
        toggleRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the panel so the next Tab lands on a menu item.
    panelRef.current?.querySelector<HTMLElement>('a,button')?.focus();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300 ${
        scrolled || open
          ? 'border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] backdrop-blur-md'
          : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex h-[68px] max-w-[1200px] items-center justify-between gap-6 px-6 sm:px-8 lg:px-10">
        <Link
          to="/"
          className="flex items-baseline gap-1.5 font-serif text-[17px] tracking-tight"
          aria-label="agent-eval home"
        >
          agent-eval
          <span aria-hidden="true" className="font-mono text-xs text-[var(--text-muted)]">
            //
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => (
            <NavLinkItem key={item.label} item={item} />
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {authenticated ? (
            <Link to="/runs" className={primaryButton + ' h-9 px-4'}>
              Open dashboard
            </Link>
          ) : (
            <>
              <Link
                to="/signin"
                className="rounded-md px-3 py-2 text-sm text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
              >
                Sign in
              </Link>
              <Link to="/signin" className={primaryButton + ' h-9 px-4'}>
                Get started
              </Link>
            </>
          )}
        </div>

        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="landing-mobile-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="grid size-9 place-items-center rounded-md border border-[var(--border)] md:hidden"
        >
          {open ? (
            <X className="size-4" aria-hidden="true" />
          ) : (
            <Menu className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Rendered only when open, so its links are never reachable by keyboard
          while hidden — the failure mode of a menu that is merely translated
          off screen. */}
      {open ? (
        <div
          id="landing-mobile-menu"
          ref={panelRef}
          className="animate-[menuIn_200ms_ease-out] border-t border-[var(--border)] bg-[var(--surface)] md:hidden"
        >
          <nav aria-label="Main" className="mx-auto max-w-[1200px] px-6 py-4">
            <ul className="space-y-1">
              {NAV_ITEMS.map((item) => (
                <li key={item.label}>
                  <NavLinkItem item={item} mobile onNavigate={() => setOpen(false)} />
                </li>
              ))}
            </ul>

            <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-4">
              {authenticated ? (
                <Link
                  to="/runs"
                  onClick={() => setOpen(false)}
                  className={primaryButton + ' w-full'}
                >
                  Open dashboard
                </Link>
              ) : (
                <>
                  <Link
                    to="/signin"
                    onClick={() => setOpen(false)}
                    className="block rounded-md px-3 py-2 text-sm text-[var(--text-muted)]"
                  >
                    Sign in
                  </Link>
                  <Link
                    to="/signin"
                    onClick={() => setOpen(false)}
                    className={primaryButton + ' w-full'}
                  >
                    Get started
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

function NavLinkItem({
  item,
  mobile,
  onNavigate,
}: {
  item: NavItem;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const base = mobile
    ? 'block rounded-md px-3 py-2 text-sm text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]'
    : 'rounded-md px-3 py-2 text-sm text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]';

  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer noopener" className={base} onClick={onNavigate}>
        {item.label}
      </a>
    );
  }

  if (item.route) {
    return (
      <Link to={item.href} className={base} onClick={onNavigate}>
        {item.label}
      </Link>
    );
  }

  // An in-page anchor. Native behaviour plus scroll-mt on the target handles
  // the sticky header, and CSS scroll-behavior handles the smoothness — which
  // also means it respects prefers-reduced-motion without extra work.
  return (
    <a href={item.href} className={base} onClick={onNavigate}>
      {item.label}
    </a>
  );
}
