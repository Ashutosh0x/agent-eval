import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { FileBadge, Moon, PlayCircle, ScrollText, Sun } from 'lucide-react';
import { ProfileMenu } from './components/ProfileMenu';
import { EvidenceBundleView } from './pages/EvidenceBundle';
import { ProfilePage } from './pages/Profile';
import { AuditLog, Runs } from './pages/RunsAndAudit';
import { RunDetailPage } from './pages/RunDetail';
import { SettingsPage } from './pages/Settings';
import { DEV_TOKEN, clearToken, getToken, setToken } from './lib/api';
import { IdentityProvider, useIdentity } from './lib/identity';
import { applyTheme, readTheme, resolveTheme, writeTheme, type ThemeChoice } from './lib/theme';

export default function App() {
  const [token, setTokenState] = useState(getToken());

  if (!token) {
    return (
      <TokenGate
        onSubmit={(t) => {
          setToken(t);
          setTokenState(t);
        }}
      />
    );
  }

  return (
    <BrowserRouter>
      <IdentityProvider>
        <Shell
          onSignOut={() => {
            clearToken();
            setTokenState('');
          }}
        />
      </IdentityProvider>
    </BrowserRouter>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);
  const [bundleId, setBundleId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { can } = useIdentity();

  useEffect(() => {
    applyTheme(theme);
    // A "system" preference must keep following the OS after it is chosen.
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  function setTheme(choice: ThemeChoice) {
    writeTheme(choice);
    setThemeState(choice);
  }

  return (
    <div className="min-h-full">
      <header className="border-b border-[var(--border)] no-print">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex items-center gap-8">
            <NavLink to="/runs" className="font-serif text-lg">
              agent-eval
            </NavLink>
            <nav className="flex gap-1">
              <Tab to="/runs" Icon={PlayCircle}>
                Runs
              </Tab>
              {can('audit:read') ? (
                <Tab to="/audit" Icon={ScrollText}>
                  Audit log
                </Tab>
              ) : null}
              {bundleId ? (
                <Tab to={`/bundles/${bundleId}`} Icon={FileBadge}>
                  Bundle
                </Tab>
              ) : null}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTheme(resolveTheme(theme) === 'dark' ? 'light' : 'dark')}
              aria-label={
                resolveTheme(theme) === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
              }
              className="grid size-8 place-items-center rounded-md border border-[var(--border)] bg-[var(--surface-raised)] hover:border-[var(--text-muted)]"
            >
              {resolveTheme(theme) === 'dark' ? (
                <Sun className="size-4" aria-hidden="true" />
              ) : (
                <Moon className="size-4" aria-hidden="true" />
              )}
            </button>
            <ProfileMenu onSignOut={onSignOut} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/runs" replace />} />
          <Route
            path="/runs"
            element={
              <Runs
                onBundle={(id) => {
                  setBundleId(id);
                  navigate(`/bundles/${id}`);
                }}
              />
            }
          />
          <Route path="/runs/:runId" element={<RunDetailPage />} />
          <Route path="/audit" element={<AuditLog />} />
          <Route path="/bundles/:id" element={<BundleRoute />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings/*" element={<SettingsPage theme={theme} onThemeChange={setTheme} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function BundleRoute() {
  const id = window.location.pathname.split('/').pop() ?? '';
  return <EvidenceBundleView bundleId={id} />;
}

function NotFound() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm">No such page.</p>
      <NavLink to="/runs" className="mt-2 inline-block text-sm underline">
        Back to runs
      </NavLink>
    </div>
  );
}

function Tab({
  to,
  Icon,
  children,
}: {
  to: string;
  Icon: typeof PlayCircle;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${
          isActive ? 'bg-[var(--surface-raised)] font-medium' : 'text-[var(--text-muted)]'
        }`
      }
    >
      <Icon className="size-4" aria-hidden="true" />
      {children}
    </NavLink>
  );
}

/**
 * A browser cannot set an Authorization header, which is the entire reason
 * this screen exists rather than expecting people to use curl.
 */
function TokenGate({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [value, setValue] = useState(DEV_TOKEN);
  return (
    <div className="grid min-h-full place-items-center p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="w-full max-w-xl space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-8"
      >
        <h1 className="font-serif text-xl">agent-eval</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Paste an access token. In development the format is{' '}
          <span className="font-mono text-xs">&lt;tenant&gt;:&lt;actor&gt;:&lt;scopes&gt;</span> —
          anything before the first colon is the tenant, so two different tenant strings give you
          two isolated worlds.
        </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          aria-label="Access token"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-xs"
        />
        <button
          type="submit"
          className="rounded-md bg-[var(--text)] px-4 py-2 text-sm font-medium text-[var(--surface)]"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
