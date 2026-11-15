import '@testing-library/jest-dom';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react';
import AccountMenu, { initialsOf, openNarado } from '../AccountMenu';
import { renderWithApp } from './helpers';

describe('Account menu', () => {
  afterEach(() => {
    delete window.naradoAuth;
  });

  it('shows the signed-in person, with the admin console only for admins', async () => {
    window.naradoAuth = { mode: 'oidc', user: { name: 'Alice Smith', email: 'alice@acme.com' }, isAdmin: false };
    renderWithApp(<AccountMenu />);
    const button = screen.getByTestId('narado-account');
    expect(button).toHaveTextContent('Alice Smith');
    expect(button).toHaveTextContent('AS');
    fireEvent.click(button);
    expect(await screen.findByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByText('Admin console')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('narado:auth', { detail: { ...window.naradoAuth, isAdmin: true } }));
    });
    expect(await screen.findByText('Admin console')).toBeInTheDocument();
  });

  it('is absent when nobody is signed in with SSO', () => {
    window.naradoAuth = { mode: 'local', user: null };
    renderWithApp(<AccountMenu />);
    expect(screen.queryByTestId('narado-account')).not.toBeInTheDocument();
  });

  it('asks the Git section for its dialogs, and makes initials', () => {
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener('narado:open', on);
    openNarado('devices');
    window.removeEventListener('narado:open', on);
    expect(seen).toEqual(['devices']);
    expect(initialsOf('dockertest@narado.test')).toBe('D');
    expect(initialsOf('Mary-Jane Watson')).toBe('MW');
  });
});
