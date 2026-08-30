/**
 * Endpoint reference.
 *
 * Method badges are text in mono, not coloured blocks. This product spends
 * colour on truth-state, and a wall of green GET / orange POST pills would
 * spend it on something that carries no risk information.
 */

import { ArrowLeft, ChevronRight, Code2, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ENDPOINTS, ENDPOINT_GROUPS, type EndpointDoc } from '../lib/endpoints';
import { useIdentity } from '../lib/identity';

export function EndpointReference() {
  const { can } = useIdentity();

  return (
    <section>
      <header className="mb-4">
        <Link
          to="/settings/developer"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Developer API
        </Link>
        <h2 className="flex items-center gap-2 text-lg font-medium">
          <Code2 className="size-4 text-[var(--text-muted)]" aria-hidden="true" />
          Endpoint reference
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {ENDPOINTS.length} routes. The OpenAPI document at{' '}
          <a href="/docs" target="_blank" rel="noreferrer" className="underline">
            /docs
          </a>{' '}
          is the source of truth.
        </p>
      </header>

      <div className="space-y-6">
        {ENDPOINT_GROUPS.map((group) => {
          const rows = ENDPOINTS.filter((e) => e.group === group);
          if (rows.length === 0) return null;
          return (
            <div key={group}>
              <h3 className="mb-2 text-sm font-medium">{group}</h3>
              <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                {rows.map((e) => (
                  <EndpointRow key={`${e.method} ${e.path}`} endpoint={e} held={
                    e.scope === null ? true : can(e.scope)
                  } />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function EndpointRow({ endpoint, held }: { endpoint: EndpointDoc; held: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 p-3 text-left hover:bg-[var(--surface-raised)]"
      >
        <span className="mt-px w-12 shrink-0 font-mono text-xs text-[var(--text-muted)]">
          {endpoint.method}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block overflow-x-auto whitespace-nowrap font-mono text-xs">
            {endpoint.path}
          </span>
          <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{endpoint.summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {endpoint.scope ? (
            <span
              className={`font-mono text-[11px] ${held ? 'text-[var(--text-muted)]' : 'text-[var(--pending)]'}`}
              title={held ? 'Your token carries this scope' : 'Your token does not carry this scope'}
            >
              {endpoint.scope}
            </span>
          ) : (
            <span className="text-[11px] text-[var(--text-muted)]">public</span>
          )}
          <ChevronRight
            className={`size-4 text-[var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>

      {open ? (
        <dl className="space-y-2 border-t border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
          {endpoint.detail ? (
            <div>
              <dt className="text-[var(--text-muted)]">Notes</dt>
              <dd className="mt-0.5">{endpoint.detail}</dd>
            </div>
          ) : null}
          <div className="flex gap-6">
            <div>
              <dt className="text-[var(--text-muted)]">Authentication</dt>
              <dd className="mt-0.5 font-mono">{endpoint.auth ? 'Bearer' : 'none'}</dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Required scope</dt>
              <dd className="mt-0.5 font-mono">{endpoint.scope ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">Your token</dt>
              <dd className="mt-0.5">{held ? 'permitted' : 'insufficient scope'}</dd>
            </div>
          </div>
          {endpoint.backendOnly ? (
            <p className="text-[var(--text-muted)]">
              No screen calls this yet — it is reachable from the API client and from curl.
            </p>
          ) : null}
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 pt-1 underline"
          >
            Try it in the API documentation
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </dl>
      ) : null}
    </li>
  );
}
