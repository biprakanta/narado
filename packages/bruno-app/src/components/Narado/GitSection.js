import { useCallback, useEffect, useState } from 'react';
import { IconCloudDownload, IconCompass, IconDots, IconGitBranch, IconKey, IconLock, IconLogout, IconRefresh } from '@tabler/icons';
import toast from 'react-hot-toast';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import MenuDropdown from 'ui/MenuDropdown';
import GitSectionStyles from './GitSectionStyles';
import { useStore } from 'react-redux';
import { focusCollection } from './focusCollection';
import OpenRepoModal from './OpenRepoModal';
import ExploreModal, { syncSummary } from './ExploreModal';
import GitPanelModal from './GitPanelModal';
import McpTokensModal from './McpTokensModal';
import SecretsModal from './SecretsModal';
import { naradoApi, errorText, signOut, connectGitAccount } from './api';

const OFFERED_KEY = 'narado.git-connect-offered';

/** "just now", "5m ago", "3h ago", "2d ago". */
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** The repo's own name, without its owner: "acme/payments" -> "payments". */
const repoName = (p) => String(p || '').split('/').pop();

/** Sidebar section listing narado's Git working copies (one per repo and branch). */
const GitSection = () => {
  const [workspaces, setWorkspaces] = useState([]);
  const [synced, setSynced] = useState([]);
  const store = useStore();
  const [syncing, setSyncing] = useState(null);
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
    naradoApi
      .synced()
      .then(setSynced)
      .catch(() => setSynced([]));
  }, []);

  const syncAgain = async (c) => {
    setSyncing(c.path);
    try {
      toast.success(syncSummary(await naradoApi.sync(c.hostId, c.repoPath, c.dir)), { duration: 6000 });
      load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSyncing(null);
    }
  };

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

  // Explore is the everyday action; the rest lives in one menu.
  const menuItems = [
    ...(auth.mode === 'oidc' && auth.user ? [{ id: 'who', type: 'label', label: auth.user.name || auth.user.email }] : []),
    { id: 'secrets', label: 'Secrets', leftSection: IconLock, onClick: () => setSecretsOpen(true) },
    { id: 'mcp', label: 'MCP tokens', leftSection: IconKey, onClick: () => setTokensOpen(true) },
    { id: 'refresh', label: 'Refresh', leftSection: IconRefresh, onClick: load },
    ...(auth.mode === 'oidc' && auth.user ? [{ id: 'd1', type: 'divider' }, { id: 'signout', label: 'Sign out', leftSection: IconLogout, onClick: signOut }] : [])
  ];

  const actions = (
    <>
      <ActionIcon label="Explore APIs" onClick={() => setExplore(true)} data-testid="narado-open-btn">
        <IconCompass size={14} stroke={1.5} aria-hidden="true" />
      </ActionIcon>
      <MenuDropdown items={menuItems} placement="bottom-end" data-testid="narado-git-menu">
        <ActionIcon label="More" data-testid="narado-git-more">
          <IconDots size={14} stroke={1.5} aria-hidden="true" />
        </ActionIcon>
      </MenuDropdown>
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
          onSynced={() => load()}
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
        <GitSectionStyles className="flex flex-col pb-1" data-testid="narado-workspaces">
          {workspaces.length === 0 && synced.length === 0 && (
            <button type="button" className="narado-empty" onClick={() => setExplore(true)} data-testid="narado-explore-empty">
              Explore your team's APIs
            </button>
          )}

          {synced.length > 0 && (
            <div className="narado-group" data-testid="narado-synced-title">
              Synced copies
            </div>
          )}
          {synced.map((c) => (
            <div
              key={c.path}
              className="narado-row"
              role="button"
              tabIndex={0}
              onClick={() => focusCollection(store, c.path)}
              onKeyDown={(e) => e.key === 'Enter' && focusCollection(store, c.path)}
              title={`${c.name}: a copy of ${c.repoPath}${c.dir ? `/${c.dir}` : ''} (${c.branch} at ${c.commit}). Yours to use; Sync brings in updates.`}
              data-testid="narado-synced"
            >
              <IconCloudDownload size={14} stroke={1.5} className="narado-row-icon" aria-hidden="true" />
              <span className="narado-row-name">{c.name}</span>
              <span className="narado-row-meta">{syncing === c.path ? 'syncing…' : ago(c.syncedAt)}</span>
              <ActionIcon
                label={`Sync ${c.name}`}
                className="narado-row-actions"
                onClick={(e) => {
                  e.stopPropagation();
                  syncAgain(c);
                }}
                disabled={!!syncing}
                data-testid="narado-sync-again"
              >
                <IconRefresh size={14} stroke={1.5} aria-hidden="true" />
              </ActionIcon>
            </div>
          ))}

          {workspaces.length > 0 && <div className="narado-group">Repositories</div>}
          {workspaces.map((w) => (
            <button
              type="button"
              key={w.path}
              className="narado-row"
              onClick={() => openWorkspace(w)}
              title={`${w.repoPath} on ${w.hostName}, branch ${w.branch || '?'}`}
              data-testid="narado-workspace"
            >
              <IconGitBranch size={14} stroke={1.5} className="narado-row-icon" aria-hidden="true" />
              <span className="narado-row-name">{repoName(w.repoPath)}</span>
              <span className="narado-row-meta">{(w.branch || '?').replace(/^narado\/[^/]+\//, '')}</span>
            </button>
          ))}
        </GitSectionStyles>
      </SidebarSection>
    </>
  );
};

export default GitSection;
