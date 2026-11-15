import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { IconBrandApple, IconBrandUbuntu, IconBrandWindows, IconDeviceLaptop, IconInfoCircle, IconLogout } from '@tabler/icons';
import Modal from 'components/Modal';
import ToolHint from 'components/ToolHint';
import ActionIcon from 'ui/ActionIcon';
import useTooltipId from 'hooks/useTooltipId';
import { naradoApi, errorText } from './api';

const PLATFORMS = {
  darwin: ['macOS', IconBrandApple],
  win32: ['Windows', IconBrandWindows],
  linux: ['Linux', IconBrandUbuntu]
};

const when = (ms) =>
  ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never';

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

const DeviceRow = ({ device, isThis, onSignOut }) => {
  const infoId = useTooltipId('narado-device-info');
  const [platformName, PlatformIcon] = PLATFORMS[device.platform] || [device.platform || 'Computer', IconDeviceLaptop];
  const signOutLabel = isThis ? 'Sign out this computer' : `Sign out ${device.name}`;
  const details = `${platformName}\nSigned in ${when(device.createdAt)}\nLast used ${when(device.lastSeenAt)}`;
  return (
    <div className="flex items-center gap-2 py-1.5" data-testid="narado-device-row">
      <PlatformIcon size={16} strokeWidth={1.5} className="flex-shrink-0 opacity-70" aria-label={platformName} />
      <span className="truncate font-medium" title={device.name}>
        {device.name}
      </span>
      {isThis && (
        <span className="text-xs px-1.5 rounded flex-shrink-0" style={{ border: '1px solid currentColor', opacity: 0.7 }}>
          this computer
        </span>
      )}
      <span className="flex-1" />
      <span className="text-xs opacity-60 flex-shrink-0">{ago(device.lastSeenAt)}</span>
      <span id={infoId} className="flex items-center opacity-60 hover:opacity-100 cursor-default" aria-label={details.replace(/\n/g, '. ')} data-testid="narado-device-info">
        <IconInfoCircle size={15} strokeWidth={1.5} />
      </span>
      <ToolHint toolhintId={infoId} text={details} place="left" tooltipStyle={{ whiteSpace: 'pre-line' }} />
      <ActionIcon label={signOutLabel} aria-label={signOutLabel} onClick={() => onSignOut(device)} data-testid="narado-device-revoke">
        <IconLogout size={15} strokeWidth={1.5} />
      </ActionIcon>
    </div>
  );
};

/**
 * Computers signed in with narado desktop. Signing one out stops it at its next contact
 * with the server; Git access tokens it holds stop within minutes.
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
      <div className="flex flex-col text-sm">
        <div className="opacity-70 mb-2">Computers using narado desktop as you. Sign out any you don't recognise.</div>
        {devices && devices.length === 0 && <div className="opacity-70">No computers are signed in.</div>}
        {(devices || []).map((d) => (
          <DeviceRow key={d.id} device={d} isThis={d.id === thisDeviceId} onSignOut={revoke} />
        ))}
        {error && (
          <div className="mt-2" style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default DevicesModal;
