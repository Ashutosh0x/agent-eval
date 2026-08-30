/**
 * API keys.
 *
 * The screen is organised around one fact: the control plane cannot recover a
 * secret it never stored. So the created state is not a confirmation dialog —
 * it is the only moment the value exists, and the UI says so plainly rather
 * than burying it in a toast that can be dismissed by a stray click.
 *
 * Status uses icon + word + shape, never colour alone. This product reserves
 * colour for truth-state, and a green "Active" pill would spend that budget on
 * something that is merely administrative.
 */

import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  AlertTriangle,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type ApiKey } from '../lib/api';
import { useIdentity } from '../lib/identity';

export function ApiKeysPage() {
  const { identity, can } = useIdentity();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const load = useCallback(() => {
    api.apiKeys
      .list()
      .then((r) => {
        setKeys(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(describe(e, 'runs:read')));
  }, []);

  useEffect(load, [load]);

  const mayCreate = can('runs:write');

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h2 className="text-lg font-medium">API keys</h2>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Create scoped credentials for programmatic access to the agent-eval control plane.
          </p>
        </div>
        {mayCreate ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-1.5 text-sm hover:border-[var(--text-muted)]"
          >
            <Plus className="size-4" aria-hidden="true" />
            Create API key
          </button>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            Creating a key needs <span className="font-mono">runs:write</span>.
          </p>
        )}
      </header>

      {error ? (
        <p className="rounded-md border border-[var(--broken)] px-3 py-2 text-sm text-[var(--broken)]">
          {error}
        </p>
      ) : null}

      {keys === null ? (
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      ) : keys.length === 0 ? (
        <EmptyState onCreate={mayCreate ? () => setCreating(true) : undefined} />
      ) : (
        <KeyTable keys={keys} onRevoke={setRevoking} canRevoke={mayCreate} />
      )}

      {creating ? (
        <CreateDialog
          availableScopes={identity?.availableScopes ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {revoking ? (
        <RevokeDialog
          apiKey={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

function describe(e: unknown, scope: string): string {
  if (e instanceof ApiError) {
    if (e.problem.status === 403) return `You do not have ${scope} permission for this action.`;
    if (e.problem.status === 401) return 'Your session is not authenticated. Sign in again.';
    return e.message;
  }
  return 'Could not reach the control plane.';
}

function EmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="rounded-lg border border-[var(--border)] px-6 py-12 text-center">
      <KeyRound className="mx-auto size-5 text-[var(--text-muted)]" aria-hidden="true" />
      <p className="mt-3 text-sm">No API keys yet.</p>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Create a scoped credential for CLI, CI, or other programmatic access.
      </p>
      {onCreate ? (
        <button
          type="button"
          onClick={onCreate}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
        >
          <Plus className="size-4" aria-hidden="true" />
          Create API key
        </button>
      ) : null}
    </div>
  );
}

function KeyTable({
  keys,
  onRevoke,
  canRevoke,
}: {
  keys: ApiKey[];
  onRevoke: (k: ApiKey) => void;
  canRevoke: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--text-muted)]">
          <tr className="border-b border-[var(--border)]">
            <th className="p-3 font-medium">Name</th>
            <th className="p-3 font-medium">Key</th>
            <th className="p-3 font-medium">Scopes</th>
            <th className="p-3 font-medium">Created</th>
            <th className="p-3 font-medium">Last used</th>
            <th className="p-3 font-medium">Status</th>
            <th className="p-3 font-medium sr-only">Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className="border-b border-[var(--border)] last:border-0">
              <td className="p-3">
                <div>{k.name}</div>
                {k.description ? (
                  <div className="text-xs text-[var(--text-muted)]">{k.description}</div>
                ) : null}
              </td>
              <td className="p-3 font-mono text-xs">{k.masked}</td>
              <td className="p-3">
                <span title={k.scopes.join(', ')} className="text-xs">
                  {k.scopes.length} {k.scopes.length === 1 ? 'scope' : 'scopes'}
                </span>
              </td>
              <td className="p-3 tabular text-xs text-[var(--text-muted)]">
                {k.createdAt.slice(0, 10)}
              </td>
              <td className="p-3 tabular text-xs text-[var(--text-muted)]">
                {k.lastUsedAt ? k.lastUsedAt.slice(0, 10) : 'never'}
              </td>
              <td className="p-3">
                <Status revoked={Boolean(k.revokedAt)} />
              </td>
              <td className="p-3 text-right">
                {canRevoke && !k.revokedAt ? (
                  <button
                    type="button"
                    onClick={() => onRevoke(k)}
                    className="rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--broken)] hover:text-[var(--broken)]"
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Icon + word + shape. Never colour alone, and never a large green badge. */
function Status({ revoked }: { revoked: boolean }) {
  return revoked ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
      <X className="size-3" aria-hidden="true" />
      Revoked
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--sealed)] px-2 py-0.5 text-xs text-[var(--sealed)]">
      <Check className="size-3" aria-hidden="true" />
      Active
    </span>
  );
}

function CreateDialog({
  availableScopes,
  onClose,
  onCreated,
}: {
  availableScopes: { scope: string; description: string; consequential: boolean; held: boolean }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  // Only scopes the caller holds: the backend refuses to mint a key more
  // capable than its creator, so offering the rest would be a trap.
  const grantable = availableScopes.filter((s) => s.held);

  const toggle = (scope: string) =>
    setSelected((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.apiKeys.create(name, selected, description || undefined);
      setSecret(res.secret);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  }

  if (secret) {
    return (
      <Dialog title="API key created" Icon={KeyRound} onClose={onCreated}>
        <SecretOnce secret={secret} onDone={onCreated} />
      </Dialog>
    );
  }

  return (
    <Dialog title="Create API key" Icon={KeyRound} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            placeholder="CI runner"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Description" optional>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
          />
        </Field>

        <fieldset className="space-y-2">
          <div className="flex items-baseline justify-between">
            <legend className="text-sm font-medium">Scopes</legend>
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                onClick={() => setSelected(grantable.map((s) => s.scope))}
                className="text-[var(--text-muted)] underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setSelected([])}
                className="text-[var(--text-muted)] underline"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {grantable.map((s) => (
              <label key={s.scope} className="flex cursor-pointer items-start gap-3 p-3">
                <input
                  type="checkbox"
                  checked={selected.includes(s.scope)}
                  onChange={() => toggle(s.scope)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{s.scope}</span>
                    {s.consequential ? (
                      <span className="rounded border border-[var(--pending)] px-1.5 py-px text-[11px] text-[var(--pending)]">
                        changes state
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                    {s.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {selected.length > 0 ? (
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs font-medium">This key will be able to:</p>
            <ul className="mt-1.5 space-y-0.5">
              {selected.map((scope) => (
                <li key={scope} className="text-xs text-[var(--text-muted)]">
                  {grantable.find((s) => s.scope === scope)?.description ?? scope}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <p className="text-sm text-[var(--broken)]">{error}</p> : null}

        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || selected.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--text)] px-3 py-1.5 text-sm font-medium text-[var(--surface)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Create API key
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The one moment the secret exists.
 *
 * Hidden by default: someone creating a key on a shared screen should choose
 * to reveal it. Copy is the primary action because that is what the value is
 * for, and nothing here writes it anywhere else.
 */
function SecretOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border border-[var(--pending)] p-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--pending)]" aria-hidden="true" />
        <p className="text-sm">
          Copy this key now. The control plane stores only a hash, so it cannot show you the secret
          again — if it is lost, create a new key and revoke this one.
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
          {revealed ? secret : '•'.repeat(Math.min(secret.length, 48))}
        </code>
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide secret' : 'Reveal secret'}
          className="shrink-0 text-[var(--text-muted)]"
        >
          {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setRevealed(true);
            }
          }}
          aria-label="Copy API key"
          className="shrink-0 text-[var(--text-muted)]"
        >
          {copied ? (
            <Check className="size-4 text-[var(--sealed)]" aria-hidden="true" />
          ) : (
            <Copy className="size-4" />
          )}
        </button>
      </div>

      <div className="flex justify-end border-t border-[var(--border)] pt-4">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md bg-[var(--text)] px-3 py-1.5 text-sm font-medium text-[var(--surface)]"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function RevokeDialog({
  apiKey,
  onClose,
  onRevoked,
}: {
  apiKey: ApiKey;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title="Revoke API key?" Icon={AlertTriangle} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">
          Applications using <span className="font-medium">{apiKey.name}</span> (
          <span className="font-mono text-xs">{apiKey.masked}</span>) will immediately lose access.
        </p>
        <p className="text-sm text-[var(--text-muted)]">
          The key record is kept rather than deleted, so the audit trail still shows that the
          credential existed and who ended it.
        </p>

        {error ? <p className="text-sm text-[var(--broken)]">{error}</p> : null}

        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.apiKeys.revoke(apiKey.id);
                onRevoked();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : 'Could not revoke the key.');
                setBusy(false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--broken)] px-3 py-1.5 text-sm text-[var(--broken)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            Revoke key
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function Dialog({
  title,
  Icon,
  onClose,
  children,
}: {
  title: string;
  Icon: typeof KeyRound;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so a keyboard user is not left behind it.
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-5"
      >
        <div className="mb-4 flex items-center gap-2">
          <Icon className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
          <h3 className="font-medium">{title}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">
        {label}
        {optional ? <span className="ml-1 text-[var(--text-muted)]">optional</span> : null}
      </span>
      {children}
    </label>
  );
}
