/**
 * Header profile control.
 *
 * Same visual weight as the theme button beside it: a 32px square, thin
 * border, initials. No photograph, no gradient ring, no upload — this product
 * has no notion of a personal profile, and inventing one would be the first
 * step towards a generic SaaS account page.
 */

import { BookOpen, KeyRound, LogOut, Settings as SettingsIcon, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { initials, useIdentity } from '../lib/identity';

export function ProfileMenu({ onSignOut }: { onSignOut: () => void }) {
  const { identity, loading } = useIdentity();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click and on Escape, and return focus to the trigger so
  // keyboard users are not dropped at the top of the document.
  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = identity ? `${identity.actor}, ${identity.tenantId}` : 'Account';

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="grid size-8 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface-raised)] text-xs font-medium tracking-tight hover:border-[var(--text-muted)]"
      >
        {loading || !identity ? (
          <UserRound className="size-4" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">{initials(identity.actor)}</span>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] py-1 shadow-sm"
        >
          <div className="border-b border-[var(--border)] px-3 py-2.5">
            {identity ? (
              <>
                <p className="truncate font-mono text-xs">{identity.actor}</p>
                <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                  {identity.tenantId} · {identity.scopes.length}{' '}
                  {identity.scopes.length === 1 ? 'scope' : 'scopes'}
                </p>
              </>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Not authenticated</p>
            )}
          </div>

          <MenuLink to="/profile" Icon={UserRound} onClick={() => setOpen(false)}>
            Profile
          </MenuLink>
          <MenuLink to="/settings" Icon={SettingsIcon} onClick={() => setOpen(false)}>
            Settings
          </MenuLink>
          <MenuLink to="/settings/api-keys" Icon={KeyRound} onClick={() => setOpen(false)}>
            API keys
          </MenuLink>
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--surface)]"
          >
            <BookOpen className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
            API documentation
          </a>

          <div className="my-1 border-t border-[var(--border)]" />

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-[var(--surface)]"
          >
            <LogOut className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MenuLink({
  to,
  Icon,
  onClick,
  children,
}: {
  to: string;
  Icon: typeof UserRound;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--surface)]"
    >
      <Icon className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
      {children}
    </Link>
  );
}
