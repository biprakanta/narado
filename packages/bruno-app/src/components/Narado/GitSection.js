import { useCallback, useEffect, useState } from 'react';
import { IconBrandGit, IconKey, IconPlus, IconRefresh } from '@tabler/icons';
import toast from 'react-hot-toast';
import SidebarSection from 'components/Sidebar/SidebarSection';
import ActionIcon from 'ui/ActionIcon';
import OpenRepoModal from './OpenRepoModal';
import GitPanelModal from './GitPanelModal';
import McpTokensModal from './McpTokensModal';
import { naradoApi, errorText } from './api';

/** Sidebar section listing narado's Git working copies (one per repo and branch). */
const GitSection = () => {
  const [workspaces, setWorkspaces] = useState([]);
  const [openRepo, setOpenRepo] = useState(false);
  const [panelPath, setPanelPath] = useState(null);
  const [tokensOpen, setTokensOpen] = useState(false);

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
      <SidebarSection id="narado-git" title="Git" icon={IconBrandGit} actions={actions} className="narado-git-section">
        <div className="flex flex-col py-1" data-testid="narado-workspaces">
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
