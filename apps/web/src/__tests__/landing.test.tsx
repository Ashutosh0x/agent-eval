/**
 * Landing page and routing tests.
 *
 * The routing assertions matter more than the visual ones. Making `/` public
 * meant restructuring how the app decides between the marketing site and the
 * dashboard, and the failure mode of getting that wrong is that authenticated
 * routes either stop resolving or become reachable without a token. Both are
 * silent from the landing page's point of view, so they are pinned here.
 *
 * The content assertions exist because this page makes claims. A test that the
 * footer contains no invented social link is a test that nobody added one
 * later without noticing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { LandingPage } from '../pages/Landing';
import { GITHUB_URL } from '../components/landing/primitives';
import { ALL_SECTIONS } from '../lib/docs-content';

const TOKEN_KEY = 'agent-eval.token';
const DEV_TOKEN = 'acme:you@example.test:runs:read,runs:write,audit:read';

function renderLanding(authenticated = false) {
  return render(
    <MemoryRouter>
      <LandingPage authenticated={authenticated} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // The dashboard fetches identity on mount; the landing page must not, and
  // any route that does should not reach a real network in a test.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ actor: 'you', tenantId: 'acme', scopes: ['runs:read'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
});

describe('routing', () => {
  it('serves the landing page at / without a token', () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Evaluate AI agents.');
  });

  it('serves the landing page at / when a token exists', () => {
    window.localStorage.setItem(TOKEN_KEY, DEV_TOKEN);
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Evaluate AI agents.');
    // and offers the dashboard rather than sign-in
    expect(screen.getAllByRole('link', { name: /open dashboard/i }).length).toBeGreaterThan(0);
  });

  it('sends an unauthenticated visitor from an app route to sign in', () => {
    window.history.pushState({}, '', '/runs');
    render(<App />);
    expect(screen.getByLabelText('Access token')).toBeInTheDocument();
  });

  it('renders the dashboard on an app route when a token exists', () => {
    window.localStorage.setItem(TOKEN_KEY, DEV_TOKEN);
    window.history.pushState({}, '', '/runs');
    render(<App />);
    // The dashboard chrome, which the landing page does not have.
    expect(screen.getByRole('link', { name: /^Runs$/ })).toBeInTheDocument();
  });

  it('keeps documentation reachable without a token', () => {
    window.history.pushState({}, '', '/docs');
    render(<App />);
    expect(screen.getByLabelText('Search documentation')).toBeInTheDocument();
  });

  it('shows the token form at /signin', () => {
    window.history.pushState({}, '', '/signin');
    render(<App />);
    expect(screen.getByLabelText('Access token')).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('points every link at a real destination', () => {
    renderLanding();
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      const href = link.getAttribute('href');
      expect(href).toBeTruthy();
      // The failure this guards against is a placeholder shipped as a CTA.
      expect(href).not.toBe('#');
      expect(href).not.toBe('');
    }
  });

  it('uses the repository from the git remote', () => {
    renderLanding();
    const github = screen.getAllByRole('link', { name: /github/i });
    expect(github.length).toBeGreaterThan(0);
    for (const link of github) {
      expect(link.getAttribute('href')).toBe(GITHUB_URL);
    }
  });

  it('links only to documentation sections that exist', () => {
    // A typo here does not 404 — the docs page falls back to its first
    // section — so the reader lands somewhere plausible and wrong.
    renderLanding();
    const ids = new Set(ALL_SECTIONS.map((s) => s.id));
    const deepLinks = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('/docs/'));
    expect(deepLinks.length).toBeGreaterThan(0);
    for (const href of deepLinks) {
      expect(ids).toContain(href.replace('/docs/', ''));
    }
  });

  it('opens external links safely', () => {
    renderLanding();
    for (const link of screen.getAllByRole('link')) {
      if (link.getAttribute('href')?.startsWith('http')) {
        expect(link).toHaveAttribute('target', '_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
      }
    }
  });
});

describe('mobile menu', () => {
  it('is closed until opened, so its links are not tabbable while hidden', () => {
    renderLanding();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('landing-mobile-menu')).toBeNull();
  });

  it('opens on click and marks itself expanded', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(document.getElementById('landing-mobile-menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('closes on Escape', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.getElementById('landing-mobile-menu')).toBeNull();
  });

  it('closes when a destination is chosen', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const panel = document.getElementById('landing-mobile-menu')!;
    fireEvent.click(within(panel).getByRole('link', { name: 'Documentation' }));
    expect(document.getElementById('landing-mobile-menu')).toBeNull();
  });

  it('locks background scrolling only while open', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).not.toBe('hidden');
  });
});

describe('claims', () => {
  it('labels every illustrative product panel', () => {
    renderLanding();
    // Each demo panel must say it is a demo. An unlabelled panel showing a
    // signed bundle and a passing verification asserts a run that never ran.
    expect(screen.getAllByText('Illustrative').length).toBeGreaterThanOrEqual(5);
  });

  it('invents no social accounts', () => {
    renderLanding();
    const hrefs = screen
      .getAllByRole('link')
      .map((l) => l.getAttribute('href') ?? '')
      .join(' ');
    // Only GitHub exists for this project; nothing else may appear.
    expect(hrefs).not.toMatch(/twitter\.com|\/\/x\.com|linkedin\.com|discord/i);
  });

  it('invents no metrics', () => {
    const { container } = renderLanding();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\d+[,.]?\d*\s*(stars|forks|users|customers|downloads)/i);
    expect(text).not.toMatch(/trusted by/i);
  });

  it('avoids the marketing register the product argues against', () => {
    const { container } = renderLanding();
    const text = (container.textContent ?? '').toLowerCase();
    for (const phrase of ["world's most", 'revolutionary', 'game-chang', 'cutting-edge']) {
      expect(text).not.toContain(phrase);
    }
  });

  it('does not claim unimplemented backends or capture', () => {
    const { container } = renderLanding();
    const text = (container.textContent ?? '').toLowerCase();
    // Isolation backends are designed, not built; trajectory capture does not
    // exist. Neither may be presented as a feature.
    expect(text).not.toContain('firecracker');
    expect(text).not.toContain('gvisor');
    expect(text).not.toMatch(/trajector/);
  });

  it('lists only technologies the repository actually uses', () => {
    const { container } = renderLanding();
    const text = (container.textContent ?? '').toLowerCase();
    // No Prisma, no Go supervisor; and no libraries that are declared in
    // package.json but imported by zero files.
    for (const absent of ['prisma', 'recharts', 'zustand']) {
      expect(text).not.toContain(absent);
    }
    expect(text).toContain('fastify');
  });

  it('shows the CLI commands that exist', () => {
    // Asserted under reduced motion, where the terminal renders its full
    // output immediately rather than revealing a line at a time.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = renderLanding();
    const text = container.textContent ?? '';
    expect(text).toContain('agent-eval runs start');
    expect(text).toContain('agent-eval evidence verify');
    // The plausible invention that is not a real command.
    expect(text).not.toContain('run create');
  });
});

describe('structure and accessibility', () => {
  it('numbers its sections in the order they are read', () => {
    // These labels were 07, 09, 11, 08, 10 on first assembly: the components
    // carried their own numbers and the page composed them in another order.
    const { container } = renderLanding();
    const numbers = [...(container.textContent ?? '').matchAll(/([0-9]{2})[ ]*[/]/g)].map((m) =>
      Number(m[1]),
    );
    expect(numbers.length).toBeGreaterThanOrEqual(10);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('has exactly one h1', () => {
    renderLanding();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('gives every section a heading', () => {
    renderLanding();
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(10);
  });

  it('labels the icon-only social link', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: 'agent-eval on GitHub' })).toBeInTheDocument();
  });

  it('names every navigation landmark', () => {
    renderLanding();
    for (const nav of screen.getAllByRole('navigation')) {
      expect(nav.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('uses buttons for actions and links for navigation', () => {
    renderLanding();
    // The evidence file switcher changes state; it must not be a link.
    const manifest = screen.getByRole('button', { name: /manifest/i });
    expect(manifest.tagName).toBe('BUTTON');
  });

  it('renders its content when motion is reduced', () => {
    // The reveal must not depend on an observer that a reduced-motion visitor
    // never triggers, or the page would be blank for them.
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    renderLanding();
    expect(screen.getByText(/Everything needed to evaluate agents/)).toBeVisible();
  });
});
