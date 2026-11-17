import '@testing-library/jest-dom';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import TerminalGate from '../TerminalGate';
import McpTokensModal from '../McpTokensModal';
import { fakeServer, renderWithApp } from './helpers';

jest.mock('react-hot-toast', () => ({ __esModule: true, default: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));

const asDesktop = (routes) => {
  const calls = fakeServer(routes);
  window.isBrunoWeb = false;
  window.isNaradoDesktop = true;
  return calls;
};

const settingsFrom = (s, allowed = { mcp: 'write', terminal: true }) => ({ ...s, allowed, terminalOn: s.terminal && allowed.terminal });

describe('narado desktop on this computer', () => {
  afterEach(() => {
    delete window.isNaradoDesktop;
  });

  it('keeps the terminal off until the person turns it on, and can turn it off again', async () => {
    let s = { mcp: { enabled: false, port: 4180 }, terminal: false };
    const calls = asDesktop({
      'narado:desktop-settings': () => settingsFrom(s),
      'narado:desktop-settings-update': (changes) => {
        s = { ...s, ...changes };
        return settingsFrom(s);
      }
    });
    renderWithApp(
      <TerminalGate>
        <div data-testid="the-terminal" />
      </TerminalGate>
    );
    expect(await screen.findByTestId('narado-terminal-off')).toBeInTheDocument();
    expect(screen.queryByTestId('the-terminal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('narado-terminal-turn-on'));
    expect(await screen.findByTestId('the-terminal')).toBeInTheDocument();
    expect(calls.find(([c]) => c === 'narado:desktop-settings-update')[1]).toEqual({ terminal: true });
    fireEvent.click(screen.getByTestId('narado-terminal-turn-off'));
    expect(await screen.findByTestId('narado-terminal-off')).toBeInTheDocument();
  });

  it('says so when the organisation\'s policy keeps the terminal off', async () => {
    asDesktop({ 'narado:desktop-settings': () => settingsFrom({ mcp: { enabled: false, port: 4180 }, terminal: true }, { mcp: 'write', terminal: false }) });
    renderWithApp(
      <TerminalGate>
        <div data-testid="the-terminal" />
      </TerminalGate>
    );
    expect(await screen.findByText(/don't allow the terminal/)).toBeInTheDocument();
    expect(screen.queryByTestId('narado-terminal-turn-on')).not.toBeInTheDocument();
    expect(screen.queryByTestId('the-terminal')).not.toBeInTheDocument();
  });

  it('has no terminal in the browser', async () => {
    fakeServer({});
    renderWithApp(
      <TerminalGate>
        <div data-testid="the-terminal" />
      </TerminalGate>
    );
    expect(screen.getByTestId('narado-terminal-web')).toBeInTheDocument();
    expect(screen.queryByTestId('the-terminal')).not.toBeInTheDocument();
  });

  it('switches the MCP server on this computer from the tokens screen', async () => {
    let info = { url: 'http://127.0.0.1:4180/mcp', writeAllowed: true, desktop: true, enabled: false, running: false, port: 4180, error: null, policy: 'write' };
    const calls = asDesktop({
      'narado:mcp-info': () => info,
      'narado:mcp-tokens': () => [],
      'narado:desktop-settings-update': ({ mcp }) => {
        if (mcp.port) info = { ...info, port: mcp.port, url: `http://127.0.0.1:${mcp.port}/mcp` };
        if ('enabled' in mcp) info = { ...info, enabled: mcp.enabled, running: mcp.enabled };
        return {};
      }
    });
    renderWithApp(<McpTokensModal onClose={() => {}} />);
    expect(await screen.findByTestId('narado-mcp-local-status')).toHaveTextContent(/^Off/);
    expect(screen.getByText(/on this computer only/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('narado-mcp-local-toggle'));
    await waitFor(() => expect(screen.getByTestId('narado-mcp-local-status')).toHaveTextContent('Running at http://127.0.0.1:4180/mcp'));

    fireEvent.change(screen.getByTestId('narado-mcp-local-port'), { target: { value: '5222' } });
    fireEvent.click(screen.getByText('Change port'));
    await waitFor(() => expect(screen.getByTestId('narado-mcp-local-status')).toHaveTextContent('Running at http://127.0.0.1:5222/mcp'));
    expect(calls.filter(([c]) => c === 'narado:desktop-settings-update').map(([, a]) => a)).toEqual([{ mcp: { enabled: true } }, { mcp: { port: 5222 } }]);
  });

  it('explains when the organisation turns MCP off on the desktop', async () => {
    asDesktop({
      'narado:mcp-info': () => ({ url: 'http://127.0.0.1:4180/mcp', writeAllowed: false, desktop: true, enabled: true, running: false, port: 4180, error: null, policy: 'off' }),
      'narado:mcp-tokens': () => []
    });
    renderWithApp(<McpTokensModal onClose={() => {}} />);
    expect(await screen.findByTestId('narado-mcp-local-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('narado-mcp-local-toggle')).not.toBeInTheDocument();
  });
});
