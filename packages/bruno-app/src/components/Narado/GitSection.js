import { useCallback, useEffect, useState } from 'react';
import { IconGitBranch, IconKey, IconLock, IconPlus, IconRefresh } from '@tabler/icons';
import toast from 'react-hot-toast';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import OpenRepoModal from './OpenRepoModal';
import GitPanelModal from './GitPanelModal';
import McpTokensModal from './McpTokensModal';
import SecretsModal from './SecretsModal';
import { naradoApi, errorText, signOut } from './api';

/** Sidebar section listing narado's Git working copies (one per repo and branch). */
const GitSection = () => {
  const [workspaces, setWorkspaces] = useState([]);
  const [openRepo, setOpenRepo] = useState(false);
  const [panelPath, setPanelPath] = useState(null);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [auth, setAuth] = useState(() => window.naradoAuth || { mode: 'unknown', user: null });

  useEffect(() => {
    const onAuth = (e) => setAuth(e.detail);
    window.addEventListener('narado:auth', onAuth);
    return () => window.removeEventListener('narado:auth', onAuth);
  }, []);

  const load = useCallback(() => {
    naradoApi
      .workspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const actions = (
    <>
      <ActionIcon label="Secrets" onClick={() => setSecretsOpen(true)} data-testid="narado-secrets-btn">
        <IconLock size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
      <ActionIcon label="MCP tokens" onClick={() => setTokensOpen(true)} data-testid="narado-mcp-btn">
        <IconKey size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
      <ActionIcon label="Refresh" onClick={load} data-testid="narado-refresh">
        <IconRefresh size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
      <ActionIcon label="Open from Git" onClick={() => setOpenRepo(true)} data-testid="narado-open-btn">
        <IconPlus size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
    </>
  );

  const openWorkspace = async (w) => {
    try {
      await naradoApi.reopen(w.path);
    } catch (err) {
      toast.error(errorText(err));
    }
    setPanelPath(w.path);
  };

  return (
    <>
      {secretsOpen && <SecretsModal onClose={() => setSecretsOpen(false)} />}
      {tokensOpen && <McpTokensModal onClose={() => setTokensOpen(false)} />}
      {openRepo && (
        <OpenRepoModal
          onClose={() => setOpenRepo(false)}
          onOpened={(ws) => {
            load();
            setPanelPath(ws.path);
          }}
        />
      )}
      {panelPath && (
        <GitPanelModal
          key={panelPath}
          path={panelPath}
          onClose={() => {
            setPanelPath(null);
            load();
          }}
          onSwitch={(nextPath) => {
            setPanelPath(nextPath);
            load();
          }}
        />
      )}
      <SidebarSection id="narado-git" title="Git" icon={IconGitBranch} actions={actions} className="narado-git-section">
        <div className="flex flex-col py-1" data-testid="narado-workspaces">
          {auth.mode === 'oidc' && auth.user && (
            <div className="px-4 py-1 flex items-center justify-between gap-2 text-xs opacity-80" data-testid="narado-signed-in">
              <span className="truncate" title={auth.user.email || ''}>Signed in as {auth.user.name || auth.user.email}</span>
              <button type="button" className="underline shrink-0" onClick={signOut} data-testid="narado-sign-out">
                Sign out
              </button>
            </div>
          )}
          {workspaces.length === 0 && (
            <button type="button" className="text-left px-4 py-1 text-xs opacity-70" onClick={() => setOpenRepo(true)}>
              Open a repo from GitHub or GitLab
            </button>
          )}
          {workspaces.map((w) => (
            <button
              type="button"
              key={w.path}
              className="text-left px-4 py-1 flex flex-col hover:opacity-100 opacity-90"
              onClick={() => openWorkspace(w)}
              title={`${w.hostName}: ${w.repoPath}`}
              data-testid="narado-workspace"
            >
              <span className="truncate text-sm">{w.repoPath}</span>
              <span className="truncate text-xs opacity-70">{w.branch || '?'}</span>
            </button>
          ))}
        </div>
      </SidebarSection>
    </>
  );
};

export default GitSection;
