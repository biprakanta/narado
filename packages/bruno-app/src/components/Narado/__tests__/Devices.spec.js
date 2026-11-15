import '@testing-library/jest-dom';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import DevicesModal from '../DevicesModal';
import DesktopSignInModal from '../DesktopSignInModal';
import { fakeServer, renderWithApp } from './helpers';

// Tooltips need the app's theme provider; the hover text is checked through aria-label.
jest.mock('components/ToolHint', () => ({ __esModule: true, default: () => null }));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));

describe('Devices', () => {
  beforeEach(() => {
    window.confirm = jest.fn(() => true);
  });

  it('lists signed-in computers, marks this one, and signs another out', async () => {
    let devices = [
      { id: 'd1', name: 'alice-mbp', platform: 'darwin', createdAt: 1, lastSeenAt: 2 },
      { id: 'd2', name: 'old-pc', platform: 'win32', createdAt: 1, lastSeenAt: 1 }
    ];
    const calls = fakeServer({
      'narado:devices': () => devices,
      'narado:device-revoke': ({ id }) => {
        devices = devices.filter((d) => d.id !== id);
        return true;
      }
    });
    renderWithApp(<DevicesModal thisDeviceId="d1" onClose={() => {}} />);
    expect(await screen.findByText(/alice-mbp/)).toBeInTheDocument();
    // One compact line each; platform and dates are in the hover details.
    expect(screen.getAllByTestId('narado-device-row')[0]).toHaveTextContent('this computer');
    expect(screen.getAllByTestId('narado-device-row')[1]).not.toHaveTextContent('this computer');
    expect(screen.getAllByTestId('narado-device-info')[0].getAttribute('aria-label')).toMatch(/^macOS\. Signed in .+\. Last used /);
    expect(screen.getAllByTestId('narado-device-info')[1].getAttribute('aria-label')).toMatch(/^Windows\./);
    expect(screen.getAllByTestId('narado-device-revoke')[0]).toHaveAttribute('aria-label', 'Sign out this computer');

    fireEvent.click(screen.getAllByTestId('narado-device-revoke')[1]);
    await waitFor(() => expect(screen.getAllByTestId('narado-device-row')).toHaveLength(1));
    expect(calls.find(([c]) => c === 'narado:device-revoke')[1]).toEqual({ id: 'd2' });
    expect(window.confirm.mock.calls[0][0]).toMatch(/Sign out "old-pc"/);
  });
});

describe('narado desktop sign-in', () => {
  it('signs in through the browser with the server address given', async () => {
    const calls = fakeServer({
      'narado:desktop-sign-in': ({ server }) => ({ mode: 'server', server: `https://${server}`, signedIn: true, user: { name: 'Alice' } })
    });
    const onClose = jest.fn();
    renderWithApp(<DesktopSignInModal onClose={onClose} />);
    fireEvent.change(screen.getByTestId('narado-desktop-server'), { target: { value: 'narado.example.com' } });
    fireEvent.click(screen.getByTestId('narado-desktop-sign-in-btn'));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ signedIn: true })));
    expect(calls[0]).toEqual(['narado:desktop-sign-in', { server: 'narado.example.com' }]);
  });

  it('says what went wrong, and lets the person try again', async () => {
    fakeServer({
      'narado:desktop-sign-in': () => {
        throw new Error('Error invoking remote method \'narado:desktop-sign-in\': Error: Sign-in was cancelled in the browser');
      }
    });
    const onClose = jest.fn();
    renderWithApp(<DesktopSignInModal onClose={onClose} initialServer="https://narado.example.com" />);
    fireEvent.click(screen.getByTestId('narado-desktop-sign-in-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in was cancelled in the browser');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('narado-desktop-sign-in-btn')).not.toBeDisabled();
  });
});
