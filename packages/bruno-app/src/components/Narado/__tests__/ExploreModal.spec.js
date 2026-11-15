import '@testing-library/jest-dom';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import ExploreModal, { syncSummary } from '../ExploreModal';
import { fakeServer, renderWithApp } from './helpers';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));

const catalogue = {
  hostId: 'github',
  repos: [
    { path: 'acme/payments-service', name: 'payments-service', shape: 'code+api', access: 'write', private: true, webUrl: 'https://github.com/acme/payments-service', description: 'Payments', collections: [{ dir: 'api', kind: 'openapi', name: 'Payments API', config: true, spec: 'api/payments.yaml', problem: null }] },
    { path: 'acme/partners', name: 'partners', shape: 'api', access: 'read', private: false, webUrl: 'https://github.com/acme/partners', collections: [{ dir: '', kind: 'bruno', name: 'Partner APIs', config: false, problem: null }] }
  ],
  withoutCollections: 12,
  notYetScanned: 0,
  scanning: false,
  progress: null,
  errors: []
};
const host = { id: 'github', name: 'GitHub', connected: true, via: 'account', login: 'alice-gh', emailMatch: true, canConnect: true, installUrl: 'https://github.com/apps/narado/installations/new' };

describe('Explore APIs', () => {
  it('lists repositories with APIs, labelled by kind, and searches them', async () => {
    fakeServer({ 'narado:hosts': () => [host], 'narado:catalogue': () => catalogue });
    renderWithApp(<ExploreModal onClose={() => {}} />);
    expect(await screen.findByText('acme/payments-service')).toBeInTheDocument();
    expect(screen.getByText('Code + API')).toBeInTheDocument();
    expect(screen.getByText('API repo')).toBeInTheDocument();
    expect(screen.getByText(/2 with APIs, 12 without \(hidden\)/)).toBeInTheDocument();
    expect(screen.getByText(/Showing what/)).toHaveTextContent('alice-gh');

    fireEvent.change(screen.getByTestId('narado-explore-filter'), { target: { value: 'partner' } });
    expect(screen.queryByText('acme/payments-service')).not.toBeInTheDocument();
    expect(screen.getByText('acme/partners')).toBeInTheDocument();
  });

  it('opens a collection in one click, and syncs a copy with Sync', async () => {
    const calls = fakeServer({
      'narado:hosts': () => [host],
      'narado:catalogue': () => catalogue,
      'narado:open': () => ({ path: '/w/main', collections: ['/views/main/api'] }),
      'narado:sync': () => ({ path: '/synced/x', name: 'Payments API (synced)', first: true, branch: 'main', commit: 'abc1234', kept: [] })
    });
    const onClose = jest.fn();
    const onSynced = jest.fn();
    renderWithApp(<ExploreModal onClose={onClose} onSynced={onSynced} />);
    fireEvent.click(await screen.findByTestId('narado-explore-open-acme/payments-service/api'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find(([c]) => c === 'narado:open')[1]).toEqual({ hostId: 'github', repoPath: 'acme/payments-service' });

    fireEvent.click(screen.getByTestId('narado-explore-sync-acme/partners/'));
    await waitFor(() => expect(onSynced).toHaveBeenCalled());
    expect(calls.find(([c]) => c === 'narado:sync')[1]).toEqual({ hostId: 'github', repoPath: 'acme/partners', dir: '' });
  });

  it('warns when the Git account is not verified for the sign-in email', async () => {
    fakeServer({ 'narado:hosts': () => [{ ...host, emailMatch: false }], 'narado:catalogue': () => catalogue });
    renderWithApp(<ExploreModal onClose={() => {}} />);
    expect(await screen.findByTestId('narado-explore-email-mismatch')).toHaveTextContent('don\'t include your sign-in email');
  });

  it('offers to connect when no Git account is connected', async () => {
    fakeServer({ 'narado:hosts': () => [{ ...host, connected: false, via: null, login: null, connectUrl: '/auth/git/github/connect' }] });
    renderWithApp(<ExploreModal onClose={() => {}} />);
    expect(await screen.findByText('Connect GitHub')).toBeInTheDocument();
  });

  it('says what a sync did', () => {
    expect(syncSummary({ first: true, name: 'X (synced)', branch: 'main', commit: 'abc' })).toBe('X (synced) is in your workspace (main at abc)');
    expect(syncSummary({ first: false, name: 'X (synced)', added: 1, updated: 2, removed: 0, kept: ['a.bru'] })).toBe('Synced X (synced): 1 new, 2 updated; kept your edits to 1 file');
    expect(syncSummary({ first: false, name: 'X (synced)', added: 0, updated: 0, removed: 0, kept: [] })).toBe('Synced X (synced): already up to date');
  });
});
