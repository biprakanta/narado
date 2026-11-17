import { useCallback, useEffect, useState } from 'react';
import Button from 'ui/Button';
import { desktopApi, errorText } from './api';

const Message = ({ children, testId }) => (
  <div className="flex flex-col items-center justify-center gap-3 h-full p-6 text-center text-sm" data-testid={testId}>
    {children}
  </div>
);

/**
 * Bruno's terminal in narado. In a browser there's no terminal: it would run on the server.
 * In narado desktop it runs a shell on this computer, so it stays off until the person turns
 * it on, and the organisation's policy can keep it off (desktop phase D5).
 */
const TerminalGate = ({ children }) => {
  const desktop = typeof window !== 'undefined' && !!window.isNaradoDesktop;
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await desktopApi.settings());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    if (desktop) load();
  }, [desktop, load]);

  if (!desktop) {
    return (
      <Message testId="narado-terminal-web">
        <div className="font-medium">The terminal isn't available in the browser</div>
        <div className="opacity-70">It would run on narado's server. Use narado desktop for a terminal on your own computer.</div>
      </Message>
    );
  }
  const turn = async (on) => {
    setBusy(true);
    setError('');
    try {
      setSettings(await desktopApi.updateSettings({ terminal: on }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (settings && settings.terminalOn) {
    return (
      <div className="flex flex-col h-full" data-testid="narado-terminal-on">
        <div className="flex items-center justify-end gap-2 px-2 py-1 text-xs opacity-80">
          <span>The terminal runs on this computer.</span>
          <button type="button" className="underline" disabled={busy} onClick={() => turn(false)} data-testid="narado-terminal-turn-off">
            Turn off
          </button>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    );
  }
  const turnOn = () => turn(true);
  if (!settings && !error) return <Message testId="narado-terminal-loading" />;

  const blocked = settings && !settings.allowed.terminal;
  return (
    <Message testId="narado-terminal-off">
      <div className="font-medium">The terminal is off</div>
      <div className="opacity-70" style={{ maxWidth: 460 }}>
        {blocked
          ? 'Your organisation\'s narado settings don\'t allow the terminal in narado desktop.'
          : 'It runs a shell on this computer, with your account’s access. Turn it on to use it here; you can turn it off again from this tab.'}
      </div>
      {settings && !blocked && (
        <Button size="sm" disabled={busy} onClick={turnOn} data-testid="narado-terminal-turn-on">
          {busy ? 'Turning on…' : 'Turn on the terminal'}
        </Button>
      )}
      {error && (
        <div style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
          {error}
        </div>
      )}
    </Message>
  );
};

export default TerminalGate;
