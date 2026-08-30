/**
 * Profile.
 *
 * Deliberately thin. The product has no notion of a person beyond the token
 * they are holding, and inventing display names or avatars would be
 * fabricating information the control plane does not have.
 */

import { Building2, UserRound } from 'lucide-react';
import { initials, useIdentity } from '../lib/identity';

export function ProfilePage() {
  const { identity, loading, error } = useIdentity();

  if (loading) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  if (error || !identity)
    return <p className="text-sm text-[var(--broken)]">{error ?? 'Not authenticated.'}</p>;

  return (
    <section className="max-w-2xl space-y-6">
      <h1 className="font-serif text-xl">Profile</h1>

      <div className="flex items-center gap-4">
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface-raised)] text-sm font-medium"
        >
          {initials(identity.actor)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{identity.actor}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Building2 className="size-3.5" aria-hidden="true" />
            <span className="font-mono">{identity.tenantId}</span>
          </p>
        </div>
      </div>

      <dl className="rounded-lg border border-[var(--border)]">
        <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] p-3">
          <dt className="text-sm text-[var(--text-muted)]">Actor</dt>
          <dd className="font-mono text-xs">{identity.actor}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] p-3">
          <dt className="text-sm text-[var(--text-muted)]">Tenant</dt>
          <dd className="font-mono text-xs">{identity.tenantId}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 p-3">
          <dt className="text-sm text-[var(--text-muted)]">Authorization</dt>
          <dd className="text-sm">
            {identity.scopes.length} {identity.scopes.length === 1 ? 'scope' : 'scopes'}
          </dd>
        </div>
      </dl>

      <div>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
          <UserRound className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
          Scopes on this token
        </h2>
        <ul className="flex flex-wrap gap-1.5">
          {identity.scopes.map((s) => (
            <li
              key={s}
              className="rounded border border-[var(--border)] px-2 py-0.5 font-mono text-xs"
            >
              {s}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
