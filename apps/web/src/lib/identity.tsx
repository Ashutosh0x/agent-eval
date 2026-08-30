/**
 * Who the current token says you are.
 *
 * Fetched from /v1/me rather than parsed from the token client-side. A UI that
 * decides its own permissions will eventually disagree with the thing
 * enforcing them, and the disagreement is always discovered by a user hitting
 * a 403 on a button that looked enabled.
 *
 * Hiding a control the caller cannot use is a courtesy, not a boundary. The
 * backend refuses regardless; `can()` only stops the UI from offering an
 * action that would fail.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type Identity } from './api';

interface IdentityState {
  identity: Identity | null;
  loading: boolean;
  error: string | null;
  /** Whether the current token carries a scope. */
  can: (scope: string) => boolean;
  reload: () => void;
}

const Ctx = createContext<IdentityState | null>(null);

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .me()
      .then((me) => {
        setIdentity(me);
        setError(null);
      })
      .catch((e: unknown) => {
        setIdentity(null);
        setError(
          e instanceof ApiError
            ? e.problem.status === 401
              ? 'Your token was rejected. Sign in again.'
              : e.message
            : 'Could not reach the control plane.',
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(reload, [reload]);

  const can = useCallback(
    (scope: string) => identity?.scopes.includes(scope) ?? false,
    [identity],
  );

  const value = useMemo(
    () => ({ identity, loading, error, can, reload }),
    [identity, loading, error, can, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useIdentity(): IdentityState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useIdentity must be used inside IdentityProvider');
  return ctx;
}

/** Initials for the avatar. No image, no gradient, no upload. */
export function initials(actor: string): string {
  const local = actor.split('@')[0] ?? actor;
  const parts = local.split(/[.\-_+]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}
