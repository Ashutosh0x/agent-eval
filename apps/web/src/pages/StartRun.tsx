/**
 * Start a run.
 *
 * This replaces a button that posted a fixed payload — a SWE-bench manifest
 * against an environment digest of repeated bytes. It produced a real run
 * through the real pipeline, so nothing about it was fake, but it also meant
 * the dashboard could only ever start one kind of run, and the manifest it
 * wrote described something nobody had configured.
 *
 * The form is long because a reproducible run needs every field in it. That is
 * the point rather than a shortcoming: the manifest is what makes a number
 * evidence rather than a claim, and the server refuses a run it cannot
 * describe. Defaults are offered where a value is genuinely conventional, and
 * left empty where guessing would put an untrue statement into the record.
 *
 * The model field is free text. There is no dropdown of known models here, and
 * the discovery list on the Providers screen is a convenience rather than a
 * constraint — a model released this morning must be runnable this morning.
 */

import { AlertTriangle, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, type ProviderSummary } from '../lib/api';

/**
 * Backends this deployment can actually run, and what each one is.
 *
 * The honest labels matter: `local-process` provides no isolation boundary at
 * all, and a run recorded against it must not read as though it were
 * sandboxed. The unavailable backends are still listed, because the server
 * accepts them and then fails the run with a reason — hiding them would make
 * the dashboard claim a smaller system than the API has.
 */
const BACKENDS = [
  { id: 'model', label: 'model — calls a model provider, no sandbox', available: true },
  {
    id: 'local-process',
    label: 'local-process — runs code with NO isolation boundary',
    available: true,
  },
  { id: 'firecracker', label: 'firecracker — not available in this deployment', available: false },
  {
    id: 'cloud-hypervisor',
    label: 'cloud-hypervisor — not available in this deployment',
    available: false,
  },
  { id: 'gvisor', label: 'gvisor — not available in this deployment', available: false },
  { id: 'kata', label: 'kata — not available in this deployment', available: false },
  { id: 'trusted-dev', label: 'trusted-dev — no isolation, development only', available: true },
] as const;

/**
 * Retention bases the server can resolve, taken from STANDARD_RULES.
 *
 * These ids must match the server exactly; an id that looks plausible but is
 * not registered is rejected at submission with a 422, so there is nothing to
 * be gained by offering a friendly-sounding option the platform cannot honour.
 */
const RETENTION = [
  { id: 'eu-ai-act-art-19', label: 'EU AI Act Art. 19 — logs, at least 6 months' },
  { id: 'eu-ai-act-annex-iv', label: 'EU AI Act Art. 11 + Annex IV — documentation, 10 years' },
  { id: 'hipaa-164-316', label: 'HIPAA §164.316(b)(2)(i) — 6 years' },
  { id: 'sox-17a-4', label: 'SEC 17a-4 — commonly 6 years' },
  { id: 'gdpr-storage-limitation', label: 'GDPR Art. 5(1)(e) — no longer than necessary' },
] as const;

export function StartRunForm({
  onStarted,
  onCancel,
}: {
  onStarted: (runId: string) => void;
  onCancel: () => void;
}) {
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    environmentId: '',
    environmentDigest: '',
    taskSetId: '',
    taskSetVersion: '',
    split: 'held-out',
    verifierId: '',
    verifierVersion: '',
    providerId: '',
    modelId: '',
    credentialId: '',
    temperature: '0',
    // Empty means unseeded, which the manifest records as a fact rather than
    // as a missing field.
    seed: '42',
    isolationBackend: 'model',
    toolchain: 'agent-eval=1.0.0',
  });
  const [retention, setRetention] = useState<string[]>(['eu-ai-act-art-19']);

  useEffect(() => {
    api.providers
      .list()
      .then((r) => setProviders(r.items))
      .catch(() => setProviders([]));
  }, []);

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const selectedProvider = providers?.find((p) => p.id === form.providerId);
  const isModelRun = form.isolationBackend === 'model';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setField(null);

    // "provider/model" is how a run names what to call, and the worker routes
    // on exactly this string.
    const identifier = isModelRun
      ? `${form.providerId}/${form.modelId}`
      : form.modelId || form.providerId;

    const toolchain: Record<string, string> = {};
    for (const pair of form.toolchain.split(/[,\n]/)) {
      const eq = pair.indexOf('=');
      if (eq > 0) toolchain[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }

    try {
      const { runId } = await api.runs.start({
        environmentId: form.environmentId,
        environmentDigest: form.environmentDigest,
        taskSetId: form.taskSetId,
        taskSetVersion: form.taskSetVersion,
        split: form.split,
        verifierId: form.verifierId,
        verifierVersion: form.verifierVersion,
        model: {
          identifier,
          sampling: { temperature: Number(form.temperature) },
        },
        // A reference, never a secret. The plaintext is decrypted server-side.
        ...(form.credentialId ? { credentialId: form.credentialId } : {}),
        seed: form.seed.trim() === '' ? null : Number(form.seed),
        isolationBackend: form.isolationBackend,
        toolchain,
        retentionRules: retention,
      });
      onStarted(runId);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.problem.detail ?? err.problem.title);
        setField(err.problem.field ?? null);
      } else {
        setError('Could not reach the control plane.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-6 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-5"
    >
      <header>
        <h2 className="text-lg font-medium">Start a run</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Every field below is written into the run manifest and hashed into the evidence bundle.
          The server refuses a run whose manifest would not be reproducible.
        </p>
      </header>

      {error ? (
        <p className="flex items-start gap-2 rounded-md border border-[var(--broken)] px-3 py-2 text-sm text-[var(--broken)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {error}
            {field ? <span className="font-mono"> ({field})</span> : null}
          </span>
        </p>
      ) : null}

      <Group title="What ran">
        <Text
          label="Environment reference"
          value={form.environmentId}
          onChange={set('environmentId')}
          placeholder="ghcr.io/acme/swe-env"
          required
        />
        <Text
          label="Environment digest"
          value={form.environmentDigest}
          onChange={set('environmentDigest')}
          placeholder="sha256:…"
          hint="A tag can move; a digest cannot. This is what makes the run re-creatable."
          mono
          required
        />
      </Group>

      <Group title="Model">
        <Select
          label="Provider"
          value={form.providerId}
          onChange={(v) => setForm((f) => ({ ...f, providerId: v, credentialId: '' }))}
          required={isModelRun}
          options={[
            { value: '', label: providers === null ? 'Loading…' : 'Select a provider' },
            ...(providers ?? []).map((p) => ({ value: p.id, label: p.displayName })),
          ]}
        />
        <Text
          label="Model id"
          value={form.modelId}
          onChange={set('modelId')}
          placeholder="gpt-4o-mini"
          hint="Exactly as the provider names it. Any id the provider accepts will work, including one released today — discovery on the Providers screen is a convenience, not a whitelist."
          mono
          required={isModelRun}
        />
        {selectedProvider && selectedProvider.credentials.length > 0 ? (
          <Select
            label="Credential"
            value={form.credentialId}
            onChange={set('credentialId')}
            hint="Decrypted on the server at execution time. Only the reference is stored with the run."
            options={[
              { value: '', label: 'Use the server environment' },
              ...selectedProvider.credentials.map((c) => ({
                value: c.id,
                label: `${c.name} (${c.masked})`,
              })),
            ]}
          />
        ) : selectedProvider?.requiresApiKey ? (
          <p className="text-xs text-[var(--text-muted)]">
            No stored credential for {selectedProvider.displayName}. The run will use the server
            environment, and will fail with the provider&apos;s own error if none is set.
          </p>
        ) : null}
        <Text
          label="Temperature"
          value={form.temperature}
          onChange={set('temperature')}
          hint="Recorded in the manifest. A run compared against another with different sampling is not a comparison."
          mono
        />
      </Group>

      <Group title="Task set and verifier">
        <Text
          label="Task set id"
          value={form.taskSetId}
          onChange={set('taskSetId')}
          placeholder="swe-bench-verified"
          required
        />
        <Text
          label="Task set version"
          value={form.taskSetVersion}
          onChange={set('taskSetVersion')}
          placeholder="2026.01"
          required
        />
        <Text
          label="Split"
          value={form.split}
          onChange={set('split')}
          hint="Reading a held-out split needs the splits:held-out scope."
          mono
          required
        />
        <Text
          label="Verifier id"
          value={form.verifierId}
          onChange={set('verifierId')}
          placeholder="pytest"
          required
        />
        <Text
          label="Verifier version"
          value={form.verifierVersion}
          onChange={set('verifierVersion')}
          placeholder="3.1.0"
          required
        />
      </Group>

      <Group title="Execution">
        <Select
          label="Isolation backend"
          value={form.isolationBackend}
          onChange={set('isolationBackend')}
          hint="Backends this deployment lacks are listed because the API accepts them and then fails the run with a reason. Nothing is silently substituted."
          options={BACKENDS.map((b) => ({
            value: b.id,
            label: b.available ? b.label : `${b.label} — unavailable`,
          }))}
          required
        />
        <Text
          label="Seed"
          value={form.seed}
          onChange={set('seed')}
          hint="Leave empty to record that this run was not seeded. That is a fact worth stating, not a missing value."
          mono
        />
        <Text
          label="Toolchain"
          value={form.toolchain}
          onChange={set('toolchain')}
          hint="name=version pairs, comma separated. At minimum the platform version."
          mono
          required
        />
      </Group>

      <Group title="Retention basis">
        <fieldset>
          <legend className="sr-only">Retention rules</legend>
          <p className="mb-2 text-xs text-[var(--text-muted)]">
            At least one is required. When several apply, the longest floor wins.
          </p>
          <div className="space-y-1.5">
            {RETENTION.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={retention.includes(r.id)}
                  onChange={(e) =>
                    setRetention((cur) =>
                      e.target.checked ? [...cur, r.id] : cur.filter((x) => x !== r.id),
                    )
                  }
                />
                {r.label}
              </label>
            ))}
          </div>
        </fieldset>
      </Group>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || retention.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm hover:border-[var(--text-muted)] disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Play className="size-4" aria-hidden="true" />
          )}
          {busy ? 'Starting…' : 'Start run'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Cancel
        </button>
        {retention.length === 0 ? (
          <span className="text-xs text-[var(--text-muted)]">
            Select at least one retention basis.
          </span>
        ) : null}
      </div>
    </form>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 border-b border-[var(--border)] pb-1.5 text-sm font-medium">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm">
        {label}
        {required ? <span className="text-[var(--text-muted)]"> (required)</span> : null}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        spellCheck={false}
        className={`mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm ${
          mono ? 'font-mono' : ''
        }`}
      />
      {hint ? <span className="mt-1 block text-xs text-[var(--text-muted)]">{hint}</span> : null}
    </label>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  hint,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm">
        {label}
        {required ? <span className="text-[var(--text-muted)]"> (required)</span> : null}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="mt-1 block text-xs text-[var(--text-muted)]">{hint}</span> : null}
    </label>
  );
}
