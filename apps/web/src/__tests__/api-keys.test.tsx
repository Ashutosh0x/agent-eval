/**
 * API keys UI.
 *
 * The important assertions are about the secret: shown once, hidden by
 * default, and absent from every later render. A credential screen is defined
 * by what it stops showing.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysPage } from '../pages/ApiKeys';
import { api, type ApiKey, type Identity } from '../lib/api';
import { IdentityProvider } from '../lib/identity';

const IDENTITY: Identity = {
  actor: 'you@example.test',
  tenantId: 'acme',
  scopes: ['runs:read', 'runs:write', 'audit:read'],
  authentication: 'bearer',
  availableScopes: [
    { scope: 'runs:read', description: 'View evaluation runs.', consequential: false, held: true },
    { scope: 'runs:write', description: 'Start and cancel runs.', consequential: true, held: true },
    { scope: 'audit:read', description: 'Query the audit log.', consequential: false, held: true },
    {
      scope: 'approvals:decide',
      description: 'Decide gated actions.',
      consequential: true,
      held: false,
    },
  ],
};

const KEY: ApiKey = {
  id: 'key_1',
  tenantId: 'acme',
  createdBy: 'you@example.test',
  name: 'CI runner',
  masked: 'ae_live_••••••••••9x4k',
  last4: '9x4k',
  scopes: ['runs:read'],
  createdAt: '2026-08-30T10:00:00.000Z',
};

const SECRET = 'ae_live_ZmFrZS1zZWNyZXQtZm9yLXRlc3Rpbmctb25seQ';

function renderPage() {
  return render(
    <IdentityProvider>
      <ApiKeysPage />
    </IdentityProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'me').mockResolvedValue(IDENTITY);
});

describe('listing', () => {
  it('shows an empty state with a create action', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    renderPage();
    expect(await screen.findByText('No API keys yet.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /create api key/i }).length).toBeGreaterThan(0);
  });

  it('renders keys masked, never in full', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [KEY] });
    renderPage();
    expect(await screen.findByText('ae_live_••••••••••9x4k')).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('marks status with a word, not only colour', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({
      items: [KEY, { ...KEY, id: 'key_2', name: 'Old', revokedAt: '2026-08-29T00:00:00.000Z' }],
    });
    renderPage();
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
  });

  it('shows a scope explanation instead of a create button without runs:write', async () => {
    vi.spyOn(api, 'me').mockResolvedValue({
      ...IDENTITY,
      scopes: ['runs:read'],
    });
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    const { container } = renderPage();
    // The message is split across elements ("needs " + <span>runs:write</span>),
    // so match against the rendered text rather than a single node.
    await waitFor(() =>
      expect(container.textContent).toMatch(/Creating a key needs\s*runs:write/),
    );
    expect(screen.queryByRole('button', { name: /create api key/i })).not.toBeInTheDocument();
  });
});

describe('creation', () => {
  it('offers only scopes the caller holds', async () => {
    // The backend refuses to mint a key more capable than its creator, so
    // offering the rest would be a trap.
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /create api key/i }))[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('runs:read')).toBeInTheDocument();
    expect(within(dialog).getByText('runs:write')).toBeInTheDocument();
    expect(within(dialog).queryByText('approvals:decide')).not.toBeInTheDocument();
  });

  it('marks scopes that change state', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /create api key/i }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('changes state')).toBeInTheDocument();
  });

  it('shows the secret exactly once, hidden by default', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    const create = vi.spyOn(api.apiKeys, 'create').mockResolvedValue({ key: KEY, secret: SECRET });
    renderPage();

    await userEvent.click((await screen.findAllByRole('button', { name: /create api key/i }))[0]!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /name/i }), 'CI runner');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /runs:read/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^create api key$/i }));

    await waitFor(() => expect(create).toHaveBeenCalled());

    // Warning present, secret masked until deliberately revealed.
    expect(await screen.findByText(/cannot show you the secret again/i)).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /reveal secret/i }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });

  it('will not submit without a name or a scope', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /create api key/i }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^create api key$/i })).toBeDisabled();
  });

  it('closes on Escape', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [] });
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /create api key/i }))[0]!);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('revocation', () => {
  it('confirms before revoking and explains the consequence', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [KEY] });
    const revoke = vi.spyOn(api.apiKeys, 'revoke');
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/immediately lose access/i)).toBeInTheDocument();
    // Nothing happened yet.
    expect(revoke).not.toHaveBeenCalled();
  });

  it('calls the API only after confirmation', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({ items: [KEY] });
    const revoke = vi.spyOn(api.apiKeys, 'revoke').mockResolvedValue({
      ...KEY,
      revokedAt: '2026-08-30T12:00:00.000Z',
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /revoke key/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('key_1'));
  });

  it('does not offer revoke on an already-revoked key', async () => {
    vi.spyOn(api.apiKeys, 'list').mockResolvedValue({
      items: [{ ...KEY, revokedAt: '2026-08-29T00:00:00.000Z' }],
    });
    renderPage();
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^revoke$/i })).not.toBeInTheDocument();
  });
});

describe('error handling', () => {
  it('explains a 403 in terms of the missing scope', async () => {
    const { ApiError } = await import('../lib/api');
    vi.spyOn(api.apiKeys, 'list').mockRejectedValue(
      new ApiError({ type: 't', title: 'Forbidden', status: 403 }),
    );
    renderPage();
    expect(await screen.findByText(/do not have runs:read permission/i)).toBeInTheDocument();
  });

  it('explains a 401 as a session problem', async () => {
    const { ApiError } = await import('../lib/api');
    vi.spyOn(api.apiKeys, 'list').mockRejectedValue(
      new ApiError({ type: 't', title: 'Unauthorized', status: 401 }),
    );
    renderPage();
    expect(await screen.findByText(/not authenticated/i)).toBeInTheDocument();
  });
});
