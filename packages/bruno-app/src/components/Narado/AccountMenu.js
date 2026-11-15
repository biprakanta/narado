/**
 * The signed-in person in narado's title bar (on a narado server): who they are, and their
 * account's places: the admin console for admins, their computers, MCP tokens, secrets and
 * signing out. The dialogs belong to the Git section; this asks for them with openNarado().
 */
import { useEffect, useState } from 'react';
import styled from 'styled-components';
import toast from 'react-hot-toast';
import { IconChevronDown, IconDeviceLaptop, IconKey, IconLock, IconLogout, IconSettings } from '@tabler/icons';
import MenuDropdown from 'ui/MenuDropdown';
import { errorText, openAdmin, signOut } from './api';

/** Ask the Git section to open one of narado's dialogs: explore, open-repo, devices, mcp, secrets. */
export const openNarado = (what) => window.dispatchEvent(new CustomEvent('narado:open', { detail: what }));

export const initialsOf = (name) => {
  // A name's first and last words (Mary-Jane Watson: MW); an email's name part (alice.smith@: AS).
  const raw = String(name || '').trim();
  const words = (raw.includes('@') ? raw.replace(/@.*/, '').split(/[._-]+/) : raw.split(/\s+/)).filter(Boolean);
  if (!words.length) return '?';
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
};

const Wrapper = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px 0 2px;
  margin-right: 6px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  -webkit-app-region: no-drag;

  &:hover,
  &[aria-expanded='true'] {
    background: ${(p) => p.theme.sidebar?.collection?.item?.hoverBg || 'rgba(127,127,127,.12)'};
    border-color: ${(p) => p.theme.border?.border1 || 'rgba(127,127,127,.25)'};
  }
  &:focus-visible {
    outline: 2px solid ${(p) => p.theme.brand || '#FB9B1A'};
    outline-offset: 1px;
  }

  .narado-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #1b1205;
    background: ${(p) => p.theme.brand || '#FB9B1A'};
  }
  .narado-account-name {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 900px) {
    .narado-account-name {
      display: none;
    }
  }
`;

const AccountMenu = () => {
  const [auth, setAuth] = useState(() => window.naradoAuth || null);
  useEffect(() => {
    const onAuth = (e) => setAuth(e.detail);
    window.addEventListener('narado:auth', onAuth);
    return () => window.removeEventListener('narado:auth', onAuth);
  }, []);

  if (window.isNaradoDesktop || !auth || !auth.user || auth.mode !== 'oidc') return null;
  const { user } = auth;
  const items = [
    { id: 'who', type: 'label', label: user.email && user.name ? `${user.name} · ${user.email}` : user.name || user.email },
    ...(auth.isAdmin ? [{ id: 'admin', label: 'Admin console', leftSection: IconSettings, onClick: () => Promise.resolve(openAdmin()).catch((err) => toast.error(errorText(err))), testId: 'narado-account-admin' }] : []),
    { id: 'devices', label: 'Your computers', leftSection: IconDeviceLaptop, onClick: () => openNarado('devices') },
    { id: 'mcp', label: 'MCP tokens', leftSection: IconKey, onClick: () => openNarado('mcp') },
    { id: 'secrets', label: 'Secrets', leftSection: IconLock, onClick: () => openNarado('secrets') },
    { id: 'd1', type: 'divider' },
    { id: 'signout', label: 'Sign out', leftSection: IconLogout, onClick: signOut, testId: 'narado-account-signout' }
  ];
  return (
    <MenuDropdown items={items} placement="bottom-end" data-testid="narado-account-menu">
      <Wrapper type="button" aria-label={`Account: ${user.name || user.email}`} data-testid="narado-account">
        <span className="narado-avatar" aria-hidden="true">{initialsOf(user.name || user.email)}</span>
        <span className="narado-account-name">{user.name || user.email}</span>
        <IconChevronDown size={12} stroke={1.75} aria-hidden="true" />
      </Wrapper>
    </MenuDropdown>
  );
};

export default AccountMenu;
