import '@testing-library/jest-dom';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react';
import SecretsModal from '../SecretsModal';
import { fakeServer, renderWithApp } from './helpers';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));

describe('Secrets: reveal', () => {
  afterEach(() => jest.useRealTimers());

  it('shows a value on request, then hides it after 30 seconds', async () => {
    const calls = fakeServer({
      'narado:secrets:stores': () => [{ id: 'vault', type: 'vault', configured: true, perPerson: true }],
      'narado:workspaces': () => [],
      'narado:secrets:list': () => [{ path: 'payments/staging', name: 'staging', folder: false }],
      'narado:secrets:reveal': () => ({ value: 'sk_test_123' })
    });
    renderWithApp(<SecretsModal onClose={() => {}} />);
    fireEvent.click(await screen.findByText('staging'));
    jest.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByTestId('narado-secrets-reveal'));
    });
    expect(await screen.findByText('sk_test_123')).toBeInTheDocument();
    expect(calls.find(([c]) => c === 'narado:secrets:reveal')[1]).toBe('secret://vault/payments/staging');
    expect(screen.getByTestId('narado-secrets-reveal')).toHaveTextContent('Hide');
    act(() => {
      jest.advanceTimersByTime(30500);
    });
    expect(screen.queryByText('sk_test_123')).not.toBeInTheDocument();
  });

  it('shows why a reveal was refused', async () => {
    fakeServer({
      'narado:secrets:stores': () => [{ id: 'vault', type: 'vault', configured: true }],
      'narado:workspaces': () => [],
      'narado:secrets:list': () => [{ path: 'payments/prod', name: 'prod', folder: false }],
      'narado:secrets:reveal': () => {
        throw new Error('Error invoking remote method \'narado:secrets:reveal\': Error: Showing secret values is turned off on this server');
      }
    });
    renderWithApp(<SecretsModal onClose={() => {}} />);
    fireEvent.click(await screen.findByText('prod'));
    fireEvent.click(screen.getByTestId('narado-secrets-reveal'));
    expect(await screen.findByText('Showing secret values is turned off on this server')).toBeInTheDocument();
  });
});
