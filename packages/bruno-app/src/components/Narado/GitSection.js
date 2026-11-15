import { useCallback, useEffect, useState } from 'react';
import { IconGitBranch, IconKey, IconLock, IconPlus, IconRefresh } from '@tabler/icons';
import toast from 'react-hot-toast';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import OpenRepoModal from './OpenRepoModal';
import ExploreModal from './ExploreModal';
import GitPanelModal from './GitPanelModal';
import McpTokensModal from './McpTokensModal';
import SecretsModal from './SecretsModal';
import { naradoApi, errorText, signOut, connectGitAccount } from './api';

const OFFERED_KEY = 'narado.git-connect-offered';

/** Sidebar section listing narado's Git working copies (one per repo and branch). */
const GitSection = () => {
  const [workspaces, setWorkspaces] = useState([]);
  const [openRepo, setOpenRepo] = useState(false); // false, or { hostId, repoPath } to preselect
  const [explore, setExplore] = useState(false);
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

  // Back from connecting a Git account: say how it went, and open the repo picker.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('git-connect');
    if (!outcome) return;
    const host = params.get('host') === 'github' ? 'GitHub' : params.get('host') === 'gitlab' ? 'GitLab' : params.get('host') || 'Git';
    const login = params.get('login');
    const text = {
      ok: [`Connected ${host} as ${login || 'you'}. Not you? Disconnect it in Explore APIs.`, true],
      taken: [`${host} account ${login || ''} is already connected by someone else in narado. Sign in to ${host} as yourself, then connect again.`, false],
      refused: [`${host} was not connected: the request was declined`, false],
      expired: [`That ${host} connection link expired. Try again.`, false],
      failed: [`Could not connect ${host}. Check the server log.`, false]
    }[outcome] || [`Connecting ${host}: ${outcome}`, false];
    (text[1] ? toast.success : toast.error)(text[0], { duration: 8000 });
    params.delete('git-connect');
    params.delete('host');
    params.delete('login');
    const rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : '') + window.location.hash);
    if (outcome === 'ok') setExplore(true);
  }, []);

  // Right after signing in: if no Git account is connected and the server has an app for
  // one, go straight to connecting it (once per browser session, so declining is respected).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('git-connect')) return;
    let offered = false;
    try {
      offered = sessionStorage.getItem(OFFERED_KEY) === '1';
    } catch {}
    if (offered) return;
    naradoApi
      .hosts()
      .then((list) => {
        if (list.some((h) => h.connected)) return;
        const host = list.find((h) => h.canConnect);
        if (!host) return;
        try {
          sessionStorage.setItem(OFFERED_KEY, '1');
        } catch {}
        connectGitAccount(host);
      })
      .catch(() => {});
  }, []);

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
      <ActionIcon label="Explore APIs" onClick={() => setExplore(true)} data-testid="narado-open-btn">
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
      {explore && (
        <ExploreModal
          onClose={() => setExplore(false)}
          // Browsing opens straight into the collections; the Git panel stays out of the way.
          onOpened={() => load()}
          onMoreOptions={(hostId, repoPath) => {
            setExplore(false);
            setOpenRepo({ hostId, repoPath });
          }}
        />
      )}
      {openRepo && (
        <OpenRepoModal
          initialHostId={openRepo.hostId}
          initialRepoPath={openRepo.repoPath}
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
            <button type="button" className="text-left px-4 py-1 text-xs opacity-70" onClick={() => setExplore(true)} data-testid="narado-explore-empty">
              Explore your team's APIs
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
