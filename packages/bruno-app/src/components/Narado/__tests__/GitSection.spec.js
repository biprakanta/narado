import '@testing-library/jest-dom';
import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { SidebarAccordionProvider } from 'components/Sidebar/SidebarAccordionContext';
import GitSection from '../GitSection';
import { fakeServer, renderWithApp } from './helpers';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));

const renderSection = () => renderWithApp(
  <SidebarAccordionProvider defaultExpanded={['narado-git']}>
    <GitSection />
  </SidebarAccordionProvider>
);

describe('Git section', () => {
  let assign;
  beforeEach(() => {
    sessionStorage.clear();
    assign = jest.fn();
    delete window.location;
    window.location = { pathname: '/', search: '', hash: '', assign };
    window.history.replaceState = jest.fn();
  });

  it('shows synced copies and repositories as one-line rows: repo name, short branch', async () => {
    fakeServer({
      'narado:workspaces': () => [
        { path: '/w/a', hostId: 'github', hostName: 'GitHub', repoPath: 'acme/payments-service', branch: 'narado/alice/refunds' },
        { path: '/w/b', hostId: 'github', hostName: 'GitHub', repoPath: 'acme/partners', branch: 'main' }
      ],
      'narado:synced': () => [{ path: '/s/1', name: 'Orders', repoPath: 'acme/orders', dir: 'api', branch: 'main', commit: 'abc1234', syncedAt: Date.now() - 5 * 60 * 1000 }],
      'narado:hosts': () => [{ id: 'github', connected: true, canConnect: true }]
    });
    renderSection();
    expect(await screen.findByText('Synced copies')).toBeInTheDocument();
    expect(screen.getByText('Orders')).toBeInTheDocument();
    expect(screen.getByText('5m ago')).toBeInTheDocument();
    expect(screen.getByText('payments-service')).toBeInTheDocument();
    expect(screen.getByText('refunds')).toBeInTheDocument();
    expect(screen.getByText('partners')).toBeInTheDocument();
    expect(screen.queryByText('acme/partners')).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('sends a person with no Git account straight to connecting one, once per session', async () => {
    fakeServer({
      'narado:workspaces': () => [],
      'narado:synced': () => [],
      'narado:hosts': () => [{ id: 'github', name: 'GitHub', connected: false, canConnect: true, connectUrl: '/auth/git/github/connect' }]
    });
    renderSection();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth/git/github/connect?return=%2F'));
    expect(screen.getByText('No repositories open')).toBeInTheDocument();
    expect(screen.getByTestId('narado-explore-empty')).toHaveTextContent('Explore APIs');

    assign.mockClear();
    renderSection();
    await new Promise((r) => setTimeout(r, 50));
    expect(assign).not.toHaveBeenCalled();
  });
});
