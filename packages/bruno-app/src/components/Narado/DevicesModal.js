import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { naradoApi, errorText } from './api';

const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');
const PLATFORMS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/**
 * Computers signed in with narado desktop. Signing one out stops it at its next contact
 * with the server; its Git access tokens expire within hours.
 */
const DevicesModal = ({ onClose, thisDeviceId = null }) => {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setDevices(await naradoApi.devices());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (d) => {
    const mine = d.id === thisDeviceId;
    const question = mine
      ? 'Sign out this computer? narado desktop stops using your Git accounts and secrets here until you sign in again.'
      : `Sign out "${d.name}"? narado desktop on it stops working until someone signs in there again.`;
    if (!window.confirm(question)) return;
    try {
      await naradoApi.revokeDevice(d.id);
      toast.success(mine ? 'Signed out this computer' : `Signed out "${d.name}"`);
      if (mine) return onClose();
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Modal size="md" title="Devices" hideFooter handleCancel={onClose} dataTestId="narado-devices">
      <div className="flex flex-col gap-3 text-sm">
        <div className="opacity-80">
          Computers signed in with narado desktop. They send requests with your Git accounts and secrets. Sign out any you don't recognise or no longer
          use.
        </div>
        {devices && devices.length === 0 && <div className="opacity-70">No computers are signed in.</div>}
        {(devices || []).map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2" data-testid="narado-device-row">
            <span className="flex flex-col min-w-0">
              <span className="truncate">
                {d.name}
                {d.platform ? <span className="opacity-70"> · {PLATFORMS[d.platform] || d.platform}</span> : null}
                {d.id === thisDeviceId ? <span className="opacity-70"> · this computer</span> : null}
              </span>
              <span className="text-xs opacity-70 truncate">
                Signed in {when(d.createdAt)} · last used {when(d.lastSeenAt)}
              </span>
            </span>
            <Button size="sm" variant="ghost" color="danger" onClick={() => revoke(d)} data-testid="narado-device-revoke">
              Sign out
            </Button>
          </div>
        ))}
        {error && (
          <div style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default DevicesModal;
