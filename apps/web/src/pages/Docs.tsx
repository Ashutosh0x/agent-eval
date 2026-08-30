/**
 * Documentation.
 *
 * The search is the reason this is a page rather than a link to markdown
 * files. It indexes every section's prose, code, table cells and notes, and
 * returns the section — not the page — so a question like "where does the
 * secret go" lands on the paragraph that answers it.
 *
 * Search runs against an in-memory index of a few dozen sections, so it is
 * synchronous and needs no debounce or worker. Saying that plainly is worth
 * more than the machinery someone would otherwise add: a fuzzy-matching
 * library here would be a dependency doing less than twenty lines already do.
 */

import { BookOpen, ChevronRight, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import {
  ALL_SECTIONS,
  DOC_GROUPS,
  sectionText,
  type Block,
  type DocSection,
} from '../lib/docs-content';

export function DocsPage() {
  const { sectionId } = useParams<{ sectionId?: string }>();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const active =
    ALL_SECTIONS.find((s) => s.id === sectionId) ?? ALL_SECTIONS[0]!;

  // The page is a document: a section change should start at the top of it,
  // not wherever the previous section happened to be scrolled to.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [sectionId]);

  // "/" focuses search, the convention every documentation site shares.
  // Ignored while typing, so it does not hijack a literal slash in an input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape') setQuery('');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const index = useMemo(
    () => ALL_SECTIONS.map((s) => ({ section: s, haystack: sectionText(s).toLowerCase() })),
    [],
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return null;
    const terms = q.split(/\s+/);
    return index
      .map(({ section, haystack }) => {
        // Every term must appear somewhere in the section. Ranking favours a
        // title hit, because someone typing "retention" wants the retention
        // section rather than the six sections that mention it in passing.
        if (!terms.every((t) => haystack.includes(t))) return null;
        const title = section.title.toLowerCase();
        const score =
          terms.filter((t) => title.includes(t)).length * 10 +
          terms.filter((t) => section.summary.toLowerCase().includes(t)).length * 3 +
          1;
        return { section, score, snippet: snippetFor(haystack, terms[0]!) };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
  }, [query, index]);

  return (
    <div className="flex flex-col gap-8 lg:flex-row">
      <aside className="lg:w-64 lg:shrink-0">
        <div className="lg:sticky lg:top-6">
          <label className="relative block">
            <span className="sr-only">Search documentation</span>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              type="search"
              placeholder="Search docs"
              aria-label="Search documentation"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-raised)] py-1.5 pl-8 pr-8 text-sm outline-none focus:border-[var(--text-muted)]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-[var(--border)] px-1 text-[10px] text-[var(--text-muted)]">
                /
              </kbd>
            )}
          </label>

          <nav aria-label="Documentation" className="mt-5 space-y-5">
            {DOC_GROUPS.map((group) => (
              <div key={group.id}>
                <h2 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  {group.title}
                </h2>
                <ul className="space-y-0.5">
                  {group.sections.map((s) => (
                    <li key={s.id}>
                      <NavLink
                        to={`/docs/${s.id}`}
                        className={({ isActive }) =>
                          `block rounded px-2 py-1 text-sm ${
                            isActive
                              ? 'bg-[var(--surface-raised)] text-[var(--text)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                          }`
                        }
                      >
                        {s.title}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {results ? (
          <SearchResults query={query} results={results} onPick={() => setQuery('')} />
        ) : (
          <Article section={active} />
        )}
      </div>
    </div>
  );
}

function SearchResults({
  query,
  results,
  onPick,
}: {
  query: string;
  results: { section: DocSection & { groupTitle: string }; snippet: string }[];
  onPick: () => void;
}) {
  return (
    <section>
      <h1 className="font-serif text-xl">
        {results.length} {results.length === 1 ? 'result' : 'results'} for &ldquo;{query}&rdquo;
      </h1>

      {results.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-muted)]">
          Nothing matched. Search covers every word of the documentation including code samples and
          table cells, so a term that appears nowhere here is probably not a term this platform
          uses.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {results.map(({ section, snippet }) => (
            <li key={section.id}>
              <NavLink
                to={`/docs/${section.id}`}
                onClick={onPick}
                className="block rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-4 hover:border-[var(--text-muted)]"
              >
                <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  {section.groupTitle}
                  <ChevronRight className="size-3" aria-hidden="true" />
                  <span className="text-[var(--text)]">{section.title}</span>
                </p>
                <p className="mt-1.5 text-sm text-[var(--text-muted)]">{section.summary}</p>
                {snippet ? (
                  <p className="mt-1.5 font-mono text-xs text-[var(--text-muted)]">…{snippet}…</p>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Article({ section }: { section: DocSection & { groupTitle: string } }) {
  return (
    <article className="max-w-3xl">
      <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <BookOpen className="size-3.5" aria-hidden="true" />
        {section.groupTitle}
      </p>
      <h1 className="mt-1 font-serif text-2xl">{section.title}</h1>
      <p className="mt-2 text-[var(--text-muted)]">{section.summary}</p>

      <div className="mt-7 space-y-5">
        {section.blocks.map((block, i) => (
          <BlockView key={i} block={block} />
        ))}
      </div>
    </article>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'h3':
      return <h3 className="pt-2 text-base font-medium">{block.text}</h3>;

    case 'p':
      return <p className="leading-relaxed text-[var(--text)]">{block.text}</p>;

    case 'code':
      return (
        <figure>
          {/* Wide code scrolls inside its own box; the page itself must never
              scroll sideways. */}
          <pre className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-3 font-mono text-xs leading-relaxed">
            <code>{block.code}</code>
          </pre>
          {block.caption ? (
            <figcaption className="mt-1.5 text-xs text-[var(--text-muted)]">
              {block.caption}
            </figcaption>
          ) : null}
        </figure>
      );

    case 'list':
      return block.ordered ? (
        <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed marker:text-[var(--text-muted)]">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul className="list-disc space-y-1.5 pl-5 leading-relaxed marker:text-[var(--text-muted)]">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );

    case 'table':
      return (
        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
                {block.headers.map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-3 py-2 align-top ${
                        j === 0 ? 'whitespace-nowrap font-mono text-xs' : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'note': {
      // Colour alone never carries the meaning: each note states its kind in
      // words as well, per WCAG 1.4.1.
      const tone =
        block.tone === 'danger'
          ? 'var(--broken)'
          : block.tone === 'warn'
            ? 'var(--pending)'
            : 'var(--text-muted)';
      return (
        <aside
          className="rounded-md border-l-2 bg-[var(--surface-raised)] p-3.5"
          style={{ borderLeftColor: tone }}
        >
          <p className="text-sm font-medium" style={{ color: tone }}>
            {block.title}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{block.text}</p>
        </aside>
      );
    }
  }
}

/** A window of text around the first match, for the result list. */
function snippetFor(haystack: string, term: string): string {
  const at = haystack.indexOf(term);
  if (at < 0) return '';
  const start = Math.max(0, at - 60);
  return haystack.slice(start, start + 150).replace(/\s+/g, ' ');
}
