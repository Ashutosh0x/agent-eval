/**
 * Documentation tests.
 *
 * The valuable assertions here are not about rendering — they are that the
 * documentation describes the system that exists. A docs page is the easiest
 * place in a codebase for a claim to drift out of date without anything
 * failing, so the ids it names are checked against the real ones.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DocsPage } from '../pages/Docs';
import { ALL_SECTIONS, DOC_GROUPS, sectionText } from '../lib/docs-content';

/** The results panel, excluding the sidebar that always lists every section. */
function resultRegion(): HTMLElement {
  const heading = screen.getByRole('heading', { level: 1 });
  return heading.closest('section') as HTMLElement;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/docs/:sectionId" element={<DocsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('docs content', () => {
  it('has no duplicate section ids', () => {
    const ids = ALL_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every section a summary, since search shows it', () => {
    for (const s of ALL_SECTIONS) {
      expect(s.summary.length).toBeGreaterThan(20);
      expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('documents every scope the server recognises', () => {
    // Drift here is invisible: a scope added to the server and missing from
    // the docs reads as though it does not exist.
    const text = ALL_SECTIONS.map(sectionText).join(' ');
    for (const scope of [
      'runs:read',
      'runs:write',
      'evidence:read',
      'evidence:generate',
      'approvals:decide',
      'audit:read',
      'splits:held-out',
    ]) {
      expect(text).toContain(scope);
    }
  });

  it('documents every retention rule the server can resolve', () => {
    const text = ALL_SECTIONS.map(sectionText).join(' ');
    for (const rule of [
      'eu-ai-act-art-19',
      'eu-ai-act-annex-iv',
      'hipaa-164-316',
      'sox-17a-4',
      'gdpr-storage-limitation',
    ]) {
      expect(text).toContain(rule);
    }
  });

  it('documents every registered provider', () => {
    const text = ALL_SECTIONS.map(sectionText).join(' ');
    for (const id of [
      'openai',
      'anthropic',
      'xai',
      'google',
      'deepseek',
      'mistral',
      'minimax',
      'ollama',
      'openai-compatible',
    ]) {
      expect(text).toContain(id);
    }
  });

  it('states what is not implemented rather than omitting it', () => {
    const section = ALL_SECTIONS.find((s) => s.id === 'not-implemented');
    expect(section).toBeDefined();
    const text = sectionText(section!);
    expect(text).toContain('NOT IMPLEMENTED');
    // The three most consequential absences must be named.
    expect(text).toMatch(/in-memory/i);
    expect(text).toMatch(/firecracker/i);
    expect(text).toMatch(/OIDC/);
  });
});

describe('docs page', () => {
  it('renders the first section by default', () => {
    renderAt('/docs');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(ALL_SECTIONS[0]!.title);
  });

  it('renders a section named in the URL', () => {
    renderAt('/docs/retention');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Retention rules');
  });

  it('falls back to the first section for an unknown id', () => {
    renderAt('/docs/does-not-exist');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(ALL_SECTIONS[0]!.title);
  });

  it('lists every section in the sidebar', () => {
    renderAt('/docs');
    const nav = screen.getByRole('navigation', { name: 'Documentation' });
    for (const group of DOC_GROUPS) {
      for (const s of group.sections) {
        expect(nav).toHaveTextContent(s.title);
      }
    }
  });

  it('searches across prose, not just titles', () => {
    renderAt('/docs');
    const box = screen.getByLabelText('Search documentation');
    // This phrase appears in body text, in a section whose title does not.
    fireEvent.change(box, { target: { value: 'shell history' } });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/result/);
    // Scoped to the result list: the sidebar always lists every section, so an
    // unscoped query would match the nav entry and prove nothing.
    expect(within(resultRegion()).getByText(/Storing provider credentials/)).toBeInTheDocument();
  });

  it('searches code samples and table cells', () => {
    renderAt('/docs');
    const box = screen.getByLabelText('Search documentation');
    fireEvent.change(box, { target: { value: 'AGENT_EVAL_ENCRYPTION_KEY' } });
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('0 results');
  });

  it('ranks a title match above a passing mention', () => {
    renderAt('/docs');
    fireEvent.change(screen.getByLabelText('Search documentation'), {
      target: { value: 'retention' },
    });
    const links = within(resultRegion()).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Retention rules');
  });

  it('requires every term to match', () => {
    renderAt('/docs');
    fireEvent.change(screen.getByLabelText('Search documentation'), {
      target: { value: 'retention zzzznotaword' },
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('0 results');
  });

  it('says something useful when nothing matches', () => {
    renderAt('/docs');
    fireEvent.change(screen.getByLabelText('Search documentation'), {
      target: { value: 'zzzznotaword' },
    });
    expect(screen.getByText(/Nothing matched/)).toBeInTheDocument();
  });

  it('ignores a single character, which would match everything', () => {
    renderAt('/docs');
    fireEvent.change(screen.getByLabelText('Search documentation'), { target: { value: 'a' } });
    // Still showing an article, not a result list.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(ALL_SECTIONS[0]!.title);
  });
});
