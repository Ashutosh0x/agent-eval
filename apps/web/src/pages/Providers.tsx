/**
 * Model providers.
 *
 * Three things on this screen are deliberate, because the obvious
 * implementation of each is wrong:
 *
 * 1. A provider that has not been tested has *no* status. Not green, not a
 *    grey pill with a hopeful label — absent, with a button to find out.
 *    Connection state is a fact about a request that actually happened, and a
 *    dashboard that guesses it is worse than one that says nothing.
 *
 * 2. There is no model list in this file. Models come from the provider, and
 *    where a provider exposes no enumeration API the screen says so and points
 *    at manual entry rather than substituting an array that would be stale
 *    within days of the next release.
 *
 * 3. The secret input is write-only. It is held in component state for exactly
 *    as long as it takes to submit, then cleared — including on the error
 *    path. Nothing reads it back, because the server has no route that would
 *    return it.
 */

import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Loader2,
  Lock,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type ConnectionStatus,
  type ModelListing,
  type ProviderCapabilities,
  type ProviderSummary,
} from '../lib/api';
import { useIdentity } from '../lib/identity';

function message(e: unknown): string {
  return e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e);
}

export function ProvidersPage() {
  const { can } = useIdentity();
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [encryptionConfigured, setEncryptionConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    api.providers
      .list()
      .then((r) => {
        setProviders(r.items);
        setEncryptionConfigured(r.encryptionConfigured);
        setError(null);
      })
      .catch((e: unknown) => setError(message(e)));
  }, []);

  useEffect(load, [load]);

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-medium">Model providers</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Credentials are encrypted on the server and never sent to this browser. Every connection
          status below comes from a request that actually happened.
        </p>
      </header>

      {encryptionConfigured === false ? <EncryptionWarning /> : null}

      {error ? (
        <p className="rounded-md border border-[var(--broken)] px-3 py-2 text-sm text-[var(--broken)]">
          {error}
        </p>
      ) : null}

      {providers === null && !error ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Loading providers…
        </p>
      ) : null}

      <ul className="space-y-3">
        {providers?.map((p) => (
          <li key={p.id}>
            <ProviderCard
              provider={p}
              open={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
              onChanged={load}
              mayWrite={can('runs:write')}
              encryptionConfigured={encryptionConfigured ?? false}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Shown when the master key is absent. A hard stop rather than a warning: the
 * server refuses to store a credential it cannot encrypt, so "you may have
 * trouble" would understate what is about to happen.
 */
function EncryptionWarning() {
  return (
    <div className="rounded-md border border-[var(--broken)] bg-[var(--surface-raised)] p-4">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--broken)]" aria-hidden="true" />
        <div className="space-y-2 text-sm">
          <p className="font-medium text-[var(--broken)]">
            Credential encryption is not configured
          </p>
          <p className="text-[var(--text-muted)]">
            New provider credentials cannot be saved. The server refuses to write a secret it
            cannot encrypt rather than storing it in plaintext. Set{' '}
            <span className="font-mono text-[var(--text)]">AGENT_EVAL_ENCRYPTION_KEY</span> to 64
            hex characters and restart the server. Generate one with:
          </p>
          <pre className="overflow-x-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs">
            node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
          </pre>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  open,
  onToggle,
  onChanged,
  mayWrite,
  encryptionConfigured,
}: {
  provider: ProviderSummary;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  mayWrite: boolean;
  encryptionConfigured: boolean;
}) {
  // Untested is null, never a neutral-looking status object.
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<ModelListing | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [adding, setAdding] = useState(false);

  // The newest stored credential. The server sorts by creation time, so this
  // is the one most likely to be current; the rest stay listed and revocable.
  const activeCredential = provider.credentials[0]?.id;

  async function test() {
    setTesting(true);
    try {
      setStatus(await api.providers.test(provider.id, activeCredential));
    } catch (e) {
      // A failed test is a result, not the absence of one.
      setStatus({ status: 'error', detail: message(e) });
    } finally {
      setTesting(false);
    }
  }

  async function discoverModels() {
    setLoadingModels(true);
    setModelError(null);
    try {
      setModels(await api.providers.models(provider.id, activeCredential));
    } catch (e) {
      setModelError(message(e));
      setModels(null);
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)]">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <Plug className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{provider.displayName}</p>
          <p className="font-mono text-xs text-[var(--text-muted)]">{provider.id}</p>
        </div>

        <ConfiguredBadge provider={provider} />
        {status ? <StatusBadge status={status} /> : null}

        <button
          type="button"
          onClick={test}
          disabled={testing}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:border-[var(--text-muted)] disabled:opacity-60"
        >
          {testing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden="true" />
          )}
          {testing ? 'Testing…' : 'Test connection'}
        </button>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:border-[var(--text-muted)]"
        >
          Details
          <ChevronDown
            className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </div>

      {status ? (
        <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
          {status.detail ??
            (status.status === 'connected' && status.modelCount !== undefined
              ? `${status.modelCount} models reported.`
              : 'Reachable.')}
        </p>
      ) : null}

      {open ? (
        <div className="space-y-5 border-t border-[var(--border)] p-4">
          <Capabilities capabilities={provider.capabilities} />

          <div>
            <h4 className="mb-2 text-sm font-medium">Credentials</h4>
            {provider.credentials.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                {provider.requiresApiKey
                  ? 'None stored. This provider needs an API key.'
                  : 'None needed. This provider runs without a credential.'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)]">
                {provider.credentials.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Lock className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {/* The masked form is all the browser ever receives. */}
                    <span className="font-mono text-xs text-[var(--text-muted)]">{c.masked}</span>
                    {mayWrite ? (
                      <button
                        type="button"
                        onClick={() => api.credentials.revoke(c.id).then(onChanged)}
                        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs hover:border-[var(--broken)] hover:text-[var(--broken)]"
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {mayWrite && !adding ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:border-[var(--text-muted)]"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add credential
              </button>
            ) : null}

            {adding ? (
              <CredentialForm
                provider={provider}
                encryptionConfigured={encryptionConfigured}
                onDone={() => {
                  setAdding(false);
                  onChanged();
                }}
                onCancel={() => setAdding(false)}
              />
            ) : null}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="text-sm font-medium">Models</h4>
              {provider.supportsModelListing ? (
                <button
                  type="button"
                  onClick={discoverModels}
                  disabled={loadingModels}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs hover:border-[var(--text-muted)] disabled:opacity-60"
                >
                  {loadingModels ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Boxes className="size-3.5" aria-hidden="true" />
                  )}
                  Discover models
                </button>
              ) : null}
            </div>

            {provider.modelListing === 'unsupported' ? (
              <p className="text-sm text-[var(--text-muted)]">
                This provider exposes no model-listing API. Enter a model id directly when starting
                a run — any id the provider accepts will work.
              </p>
            ) : provider.modelListing === 'unknown' ? (
              // Unknown is not no. Offering the attempt is the only way to find
              // out, and a failed probe is itself information.
              <p className="text-sm text-[var(--text-muted)]">
                It is not established whether this provider exposes a model list. Discovery will
                attempt it and report whatever comes back.
              </p>
            ) : null}

            {modelError ? (
              <p className="rounded border border-[var(--broken)] px-3 py-2 text-sm text-[var(--broken)]">
                {modelError}
              </p>
            ) : null}

            {models ? (
              models.items.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">
                  {models.note ?? 'The provider reported no models.'}
                </p>
              ) : (
                <>
                  <ul className="max-h-56 divide-y divide-[var(--border)] overflow-y-auto rounded border border-[var(--border)]">
                    {models.items.map((m) => (
                      <li key={m.id} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
                        <span className="font-mono">{m.id}</span>
                        {m.contextLength ? (
                          <span className="ml-auto shrink-0 text-xs text-[var(--text-muted)]">
                            {m.contextLength.toLocaleString()} ctx
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {/* Timestamped, so a list read minutes ago is never mistaken
                      for the provider's current state. */}
                  {models.fetchedAt ? (
                    <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                      {models.items.length} models, read from the provider at{' '}
                      {new Date(models.fetchedAt).toLocaleTimeString()}.
                    </p>
                  ) : null}
                </>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether a credential exists — which is not whether it works. Kept visually
 * distinct from connection status for exactly that reason: a stored key and a
 * working key are different claims, and conflating them is how a dashboard
 * ends up reporting green while every request fails.
 */
function ConfiguredBadge({ provider }: { provider: ProviderSummary }) {
  if (!provider.requiresApiKey) {
    return <span className="text-xs text-[var(--text-muted)]">No credential required</span>;
  }
  return (
    <span className="text-xs text-[var(--text-muted)]">
      {provider.credentialConfigured ? 'Credential stored' : 'No credential'}
    </span>
  );
}

/** Icon + word + shape. Never colour alone, per WCAG 1.4.1. */
function StatusBadge({ status }: { status: ConnectionStatus }) {
  const map = {
    connected: { Icon: CheckCircle2, label: 'Connected', tone: 'var(--verified)' },
    not_configured: { Icon: CircleSlash, label: 'Not configured', tone: 'var(--text-muted)' },
    authentication_failed: { Icon: XCircle, label: 'Auth failed', tone: 'var(--broken)' },
    unavailable: { Icon: AlertTriangle, label: 'Unavailable', tone: 'var(--pending)' },
    error: { Icon: XCircle, label: 'Error', tone: 'var(--broken)' },
  } as const;
  const { Icon, label, tone } = map[status.status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
      style={{ borderColor: tone, color: tone }}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Capabilities as the provider reports them. 'unknown' is rendered as unknown
 * rather than folded into 'no' — the two are different claims, and collapsing
 * them would put an assertion on screen that nothing verified.
 */
function Capabilities({ capabilities }: { capabilities: ProviderCapabilities }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">Capabilities</h4>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        {Object.entries(capabilities).map(([name, support]) => (
          <div key={name} className="flex items-baseline justify-between gap-2 text-xs">
            <dt className="text-[var(--text-muted)]">{humanise(name)}</dt>
            <dd
              className={
                support === 'supported'
                  ? 'text-[var(--text)]'
                  : support === 'unknown'
                    ? 'italic text-[var(--text-muted)]'
                    : 'text-[var(--text-muted)]'
              }
            >
              {support === 'supported' ? 'Yes' : support === 'unsupported' ? 'No' : 'Unknown'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function humanise(name: string): string {
  const spaced = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function CredentialForm({
  provider,
  encryptionConfigured,
  onDone,
  onCancel,
}: {
  provider: ProviderSummary;
  encryptionConfigured: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = provider.requiresApiKey && !encryptionConfigured;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.credentials.create({
        providerId: provider.id,
        name,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      // Cleared on both paths. Leaving it in state after a failed save is how
      // a secret ends up in a React DevTools snapshot or an error report.
      setApiKey('');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3 rounded border border-[var(--border)] p-3">
      <Field label="Name" hint="How you will recognise this credential, e.g. Production.">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
        />
      </Field>

      {provider.requiresApiKey ? (
        <Field
          label="API key"
          hint="Encrypted with AES-256-GCM on the server. Never returned by any endpoint, never logged, never written to the audit chain."
        >
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-sm"
          />
        </Field>
      ) : null}

      <Field
        label="Base URL"
        hint="Optional. Set this for self-hosted deployments and OpenAI-compatible gateways."
      >
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://…"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-sm"
        />
      </Field>

      {blocked ? (
        <p className="text-xs text-[var(--broken)]">
          Encryption is not configured, so this credential cannot be stored. Set
          AGENT_EVAL_ENCRYPTION_KEY first.
        </p>
      ) : null}

      {error ? <p className="text-xs text-[var(--broken)]">{error}</p> : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving || blocked}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:border-[var(--text-muted)] disabled:opacity-60"
        >
          {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          Save credential
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm">{label}</span>
      {children}
      <span className="mt-1 block text-xs text-[var(--text-muted)]">{hint}</span>
    </label>
  );
}
