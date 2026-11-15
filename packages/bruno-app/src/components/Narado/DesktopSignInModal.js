import { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { desktopApi, errorText } from './api';

/**
 * narado desktop: sign this computer in to the team's narado server. Sign-in happens in
 * the system browser with the organisation's single sign-on; the person then approves
 * this computer there.
 */
const DesktopSignInModal = ({ onClose, initialServer = '' }) => {
  const [server, setServer] = useState(initialServer);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');

  const start = async (e) => {
    if (e) e.preventDefault();
    setWaiting(true);
    setError('');
    try {
      const status = await desktopApi.signIn(server.trim());
      toast.success(`Signed in to ${new URL(status.server).host} as ${status.user ? status.user.name : 'you'}`);
      onClose(status);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWaiting(false);
    }
  };

  const copyLink = async () => {
    try {
      const link = await desktopApi.signInLink();
      if (!link) return;
      await navigator.clipboard.writeText(link);
      toast.success('Copied. Paste it into your browser.');
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <Modal size="md" title="Sign in to your narado server" hideFooter handleCancel={() => onClose(null)} dataTestId="narado-desktop-sign-in">
      <form className="flex flex-col gap-3 text-sm" onSubmit={start}>
        <div className="opacity-80">
          narado desktop uses your team's narado server for sign-in, your Git accounts and secrets. Requests are sent from this computer, so services on
          it and on your network work too.
        </div>
        <label className="flex flex-col gap-1">
          <span className="font-medium">Server address</span>
          <input
            className="block textbox w-full"
            placeholder="https://narado.example.com"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            disabled={waiting}
            autoFocus
            data-testid="narado-desktop-server"
          />
        </label>
        {waiting && (
          <div className="flex flex-col gap-1" role="status" data-testid="narado-desktop-waiting">
            <span className="opacity-80">Finish signing in in your browser, then approve this computer. This window updates when you're done.</span>
            <span>
              Browser didn't open?{' '}
              <button type="button" className="underline" onClick={copyLink} data-testid="narado-desktop-copy-link">
                Copy the sign-in link
              </button>
            </span>
          </div>
        )}
        {error && (
          <div style={{ color: 'var(--color-text-danger, #d9534f)' }} role="alert" data-testid="narado-error">
            {error}
          </div>
        )}
        <div>
          <Button size="sm" type="submit" disabled={waiting || !server.trim()} data-testid="narado-desktop-sign-in-btn">
            {waiting ? 'Waiting for the browser…' : 'Sign in with your browser'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default DesktopSignInModal;
