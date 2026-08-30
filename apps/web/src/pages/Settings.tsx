/**
 * Settings.
 *
 * A narrow section list beside a content panel, not a sidebar app. Read-only
 * values are rendered visibly read-only rather than as disabled inputs that
 * imply a save button exists somewhere — most of what a caller can see here is
 * a property of their token, not a preference.
 */

import {
  Building2,
  Code2,
  ExternalLink,
  Info,
  KeyRound,
  Plug,
  Cpu,
  Settings as SettingsIcon,
  ShieldCheck,
  SunMoon,
  Sun,
  Moon,
} from 'lucide-react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { ApiKeysPage } from './ApiKeys';
import { ComputePage } from './Compute';
import { ProvidersPage } from './Providers';
import { EndpointReference } from './EndpointReference';
import { useIdentity } from '../lib/identity';
import type { ThemeChoice } from '../lib/theme';

const SECTIONS = [
  { to: '/settings', end: true, label: 'General', Icon: SettingsIcon },
  { to: '/settings/appearance', label: 'Appearance', Icon: SunMoon },
  { to: '/settings/api-keys', label: 'API keys', Icon: KeyRound },
  { to: '/settings/providers', label: 'Providers', Icon: Plug },
  { to: '/settings/compute', label: 'Compute', Icon: Cpu },
  { to: '/settings/security', label: 'Security', Icon: ShieldCheck },
  { to: '/settings/tenant', label: 'Tenant', Icon: Building2 },
  { to: '/settings/developer', label: 'Developer API', Icon: Code2 },
  { to: '/settings/about', label: 'About', Icon: Info },
] as const;

export function SettingsPage({
  theme,
  onThemeChange,
}: {
  theme: ThemeChoice;
  onThemeChange: (t: ThemeChoice) => void;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-xl">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Configure your agent-eval control plane.
        </p>
      </header>

      <div className="flex flex-col gap-8 md:flex-row">
        <nav aria-label="Settings sections" className="md:w-48 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {SECTIONS.map(({ to, label, Icon, ...rest }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={'end' in rest ? rest.end : false}
                  className={({ isActive }) =>
                    `flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
                      isActive
                        ? 'bg-[var(--surface-raised)] font-medium'
                        : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <Routes>
            <Route index element={<General />} />
            <Route
              path="appearance"
              element={<Appearance theme={theme} onChange={onThemeChange} />}
            />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="providers" element={<ProvidersPage />} />
            <Route path="compute" element={<ComputePage />} />
            <Route path="security" element={<Security />} />
            <Route path="tenant" element={<Tenant />} />
            <Route path="developer" element={<Developer />} />
            <Route path="endpoints" element={<EndpointReference />} />
            <Route path="about" element={<About />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

/** A value the caller cannot change here. Rendered plainly, not as a field. */
function ReadOnlyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--border)] p-3 last:border-0">
      <dt className="text-sm text-[var(--text-muted)]">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="mb-4">
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{subtitle}</p>
    </header>
  );
}

function General() {
  const { identity } = useIdentity();
  return (
    <section>
      <SectionHeader title="General" subtitle="Account and control-plane configuration." />
      <dl className="rounded-lg border border-[var(--border)]">
        <ReadOnlyRow label="Actor">
          <span className="font-mono text-xs">{identity?.actor ?? '—'}</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Tenant">
          <span className="font-mono text-xs">{identity?.tenantId ?? '—'}</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Environment">Development</ReadOnlyRow>
        <ReadOnlyRow label="API base URL">
          <span className="font-mono text-xs">{window.location.origin}/v1</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Authentication">
          <span className="font-mono text-xs">bearer</span>
        </ReadOnlyRow>
      </dl>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        These are properties of the token you are holding, not preferences. Change them by
        presenting a different token.
      </p>
    </section>
  );
}

function Appearance({
  theme,
  onChange,
}: {
  theme: ThemeChoice;
  onChange: (t: ThemeChoice) => void;
}) {
  const options: { value: ThemeChoice; label: string; hint: string; Icon: typeof Sun }[] = [
    { value: 'system', label: 'System', hint: 'Follow your operating system', Icon: SunMoon },
    { value: 'light', label: 'Light', hint: 'The archival paper interface', Icon: Sun },
    { value: 'dark', label: 'Dark', hint: 'The investigation interface', Icon: Moon },
  ];

  return (
    <section>
      <SectionHeader title="Appearance" subtitle="How the control plane is rendered." />
      <fieldset className="rounded-lg border border-[var(--border)]">
        <legend className="sr-only">Theme</legend>
        {options.map(({ value, label, hint, Icon }) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-3 border-b border-[var(--border)] p-3 last:border-0"
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => onChange(value)}
              className="mt-1"
            />
            <span>
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
                {label}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        The header keeps a quick toggle. Dark mode uses separate state colours: the light values
        fail contrast on the dark ground.
      </p>
    </section>
  );
}

function Security() {
  const { identity } = useIdentity();
  return (
    <section>
      <SectionHeader
        title="Security"
        subtitle="What the current credential is authorised to do."
      />
      <dl className="rounded-lg border border-[var(--border)]">
        <ReadOnlyRow label="Authentication">Bearer token</ReadOnlyRow>
        <ReadOnlyRow label="Actor">
          <span className="font-mono text-xs">{identity?.actor ?? '—'}</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Tenant">
          <span className="font-mono text-xs">{identity?.tenantId ?? '—'}</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Authorization">
          {identity?.scopes.length ?? 0} of {identity?.availableScopes.length ?? 0} scopes
        </ReadOnlyRow>
      </dl>

      <h3 className="mb-2 mt-6 text-sm font-medium">Scopes</h3>
      <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {(identity?.availableScopes ?? []).map((s) => (
          <li key={s.scope} className="flex items-start justify-between gap-4 p-3">
            <span className="min-w-0">
              <span className="font-mono text-xs">{s.scope}</span>
              <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                {s.description}
              </span>
            </span>
            <span className="shrink-0 text-xs">
              {s.held ? (
                <span className="text-[var(--sealed)]">held</span>
              ) : (
                <span className="text-[var(--text-muted)]">not held</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tenant() {
  const { identity } = useIdentity();
  return (
    <section>
      <SectionHeader title="Tenant" subtitle="Isolation boundary for every record you can see." />
      <dl className="rounded-lg border border-[var(--border)]">
        <ReadOnlyRow label="Tenant">
          <span className="font-mono text-xs">{identity?.tenantId ?? '—'}</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Isolation">Enforced server-side</ReadOnlyRow>
      </dl>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        A record belonging to another tenant returns 404 rather than 403 — a 403 would confirm the
        identifier is real. Isolation is enforced by the control plane, not by this interface.
      </p>
    </section>
  );
}

function Developer() {
  const base = `${window.location.origin}/v1`;
  return (
    <section>
      <SectionHeader title="Developer API" subtitle="Programmatic access to the control plane." />
      <dl className="rounded-lg border border-[var(--border)]">
        <ReadOnlyRow label="API base URL">
          <span className="font-mono text-xs">{base}</span>
        </ReadOnlyRow>
        <ReadOnlyRow label="Environment">Development</ReadOnlyRow>
        <ReadOnlyRow label="Authentication">
          <span className="font-mono text-xs">Bearer</span>
        </ReadOnlyRow>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
        >
          Open API documentation
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        <NavLink
          to="/settings/endpoints"
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
        >
          <Code2 className="size-4" aria-hidden="true" />
          View endpoint reference
        </NavLink>
      </div>

      <p className="mt-3 text-xs text-[var(--text-muted)]">
        The OpenAPI document at <span className="font-mono">/docs/json</span> is the source of
        truth. The endpoint reference mirrors it with a scope column, which OpenAPI has no natural
        place for.
      </p>
    </section>
  );
}

function About() {
  return (
    <section>
      <SectionHeader title="About" subtitle="What this is." />
      <dl className="rounded-lg border border-[var(--border)]">
        <ReadOnlyRow label="Product">agent-eval control plane</ReadOnlyRow>
        <ReadOnlyRow label="Version">1.0.0</ReadOnlyRow>
        <ReadOnlyRow label="Audit log">Hash-chained, RFC 6962 Merkle tree</ReadOnlyRow>
        <ReadOnlyRow label="Signatures">Ed25519 over canonical JSON</ReadOnlyRow>
      </dl>
      <p className="mt-3 text-xs text-[var(--text-muted)]">
        Evidence bundles are verifiable without this server. The public key endpoint is
        unauthenticated on purpose.
      </p>
    </section>
  );
}
