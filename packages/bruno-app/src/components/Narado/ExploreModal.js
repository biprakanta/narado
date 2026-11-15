import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { useStore } from 'react-redux';
import { naradoApi, errorText, connectGitAccount, disconnectGitAccount } from './api';
import { focusCollection, pathForDir } from './focusCollection';

const SHAPE_LABEL = { 'api': 'API repo', 'code+api': 'Code + API' };
const KIND_LABEL = { openapi: 'OpenAPI', bruno: 'Bruno' };

/**
 * The API catalogue: every repository the person can see that holds collections, found
 * through the Git host's API as them (nothing is cloned until they open one). One click
 * opens a repository's default branch with its collections; editing then saves to a
 * branch or fork as usual.
 */
const ExploreModal = ({ onClose, onOpened, onMoreOptions }) => {
  const [hosts, setHosts] = useState(null);
  const [hostId, setHostId] = useState('');
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [opening, setOpening] = useState(null);
  const [error, setError] = useState('');
  const timer = useRef(null);
  const store = useStore();

  useEffect(() => {
    naradoApi
      .hosts()
      .then((list) => {
        setHosts(list);
        const first = list.find((h) => h.connected);
        if (first) setHostId(first.id);
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  const load = (refresh = false) =>
    naradoApi
      .catalogue(hostId, refresh)
      .then((d) => {
        setData(d);
        clearTimeout(timer.current);
        if (d.scanning) timer.current = setTimeout(() => load(false), 1500);
      })
      .catch((err) => setError(errorText(err)));

  useEffect(() => {
    if (!hostId) return undefined;
    setData(null);
    setError('');
    load(false);
    return () => clearTimeout(timer.current);
  }, [hostId]);

  const shown = useMemo(() => {
    if (!data) return [];
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return data.repos;
    return data.repos.filter((r) => {
      const text = [r.path, r.description, ...r.collections.map((c) => `${c.name} ${c.dir}`)].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [data, filter]);

  const open = async (repo, collection) => {
    setOpening(`${repo.path}/${collection ? collection.dir : ''}`);
    setError('');
    try {
      const ws = await naradoApi.open({ hostId, repoPath: repo.path });
      const others = ws.collections.length - 1;
      toast.success(`Opened ${collection ? collection.name : repo.path}${others > 0 ? ` and ${others} more from ${repo.path}` : ''}`);
      onOpened && onOpened(ws);
      onClose();
      const target = pathForDir(ws.collections, collection ? collection.dir : '');
      if (target) focusCollection(store, target);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setOpening(null);
    }
  };

  const disconnect = async (h) => {
    if (!window.confirm(`Disconnect ${h.name} account ${h.login}? narado's access on ${h.name} is withdrawn too.`)) return;
    try {
      await disconnectGitAccount(h.id);
      toast.success(`Disconnected ${h.name}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const connected = (hosts || []).filter((h) => h.connected);
  const current = connected.find((h) => h.id === hostId);
  const connectable = (hosts || []).filter((h) => !h.connected && h.canConnect);

  return (
    <Modal size="lg" title="Explore APIs" hideFooter handleCancel={onClose} dataTestId="narado-explore-modal">
      <div className="flex flex-col gap-3 text-sm" data-testid="narado-explore">
        {hosts && !connected.length && (
          <div className="flex flex-col gap-2">
            <span>Connect your Git account to see your team's APIs. narado looks through the repositories you can access, as you.</span>
            <div className="flex gap-2">
              {connectable.map((h) => (
                <button key={h.id} type="button" className="btn btn-sm btn-secondary" onClick={() => connectGitAccount(h)}>
                  Connect {h.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {connected.length > 0 && (
          <div className="flex gap-2 items-center">
            {connected.length > 1 && (
              <select className="textbox" value={hostId} onChange={(e) => setHostId(e.target.value)} data-testid="narado-explore-host">
                {connected.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            )}
            <input
              className="block textbox w-full"
              placeholder="Search APIs, repositories and folders"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
              data-testid="narado-explore-filter"
            />
            <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => load(true)} disabled={!data || data.scanning} data-testid="narado-explore-refresh">
              Refresh
            </button>
          </div>
        )}

        {current && current.via === 'account' && (
          <div className="text-xs opacity-80 flex gap-2" data-testid="narado-explore-account">
            <span>
              Showing what <strong>{current.login}</strong> can see on {current.name}.
            </span>
            {current.installUrl && (
              <a className="underline" href={current.installUrl} target="_blank" rel="noreferrer">
                Repository missing? Give the narado app access to it
              </a>
            )}
            <button type="button" className="underline" onClick={() => disconnect(current)}>
              Not you? Disconnect
            </button>
          </div>
        )}

        {hostId && (
          <div className="text-xs opacity-70" data-testid="narado-explore-status">
            {!data && 'Looking through your repositories…'}
            {data && data.scanning && data.progress && `Looking through your repositories: ${data.progress.done} of ${data.progress.total}… `}
            {data && !data.scanning && data.notYetScanned > 0 && `${data.notYetScanned} not looked at yet. `}
            {data
              && `${data.repos.length} with APIs${data.withoutCollections ? `, ${data.withoutCollections} without (hidden)` : ''}.`}
          </div>
        )}

        {data && data.errors.length > 0 && (
          <div className="text-xs" style={{ color: 'var(--color-text-warning, #d4a106)' }}>
            {data.errors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </div>
        )}

        <div className="overflow-auto flex flex-col gap-2" style={{ maxHeight: 420 }} data-testid="narado-explore-list">
          {shown.map((r) => (
            <div key={r.path} className="border rounded px-3 py-2 flex flex-col gap-1" style={{ borderColor: 'var(--color-border, rgba(127,127,127,.3))' }} data-testid={`narado-explore-repo-${r.path}`}>
              <div className="flex items-center gap-2">
                <a className="font-medium truncate hover:underline" href={r.webUrl} target="_blank" rel="noreferrer" title="Open on the Git host">
                  {r.path}
                </a>
                <span className="text-xs px-1 rounded" style={{ background: 'rgba(127,127,127,.18)' }}>
                  {SHAPE_LABEL[r.shape] || r.shape}
                </span>
                <span className="text-xs opacity-60 shrink-0">
                  {r.private ? 'private · ' : ''}
                  {r.access}
                </span>
                <span className="flex-1" />
                <button type="button" className="text-xs underline opacity-80 shrink-0" onClick={() => onMoreOptions && onMoreOptions(hostId, r.path)}>
                  Change or branch…
                </button>
              </div>
              {r.description && <div className="text-xs opacity-70 truncate">{r.description}</div>}
              {r.collections.map((c) => {
                const key = `${r.path}/${c.dir}`;
                return (
                  <button
                    type="button"
                    key={key}
                    className="text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-black/10"
                    onClick={() => open(r, c)}
                    disabled={!!opening}
                    data-testid={`narado-explore-open-${key}`}
                  >
                    <span className="truncate">{opening === key ? `Opening ${c.name}…` : c.name}</span>
                    <span className="text-xs opacity-60 shrink-0">{KIND_LABEL[c.kind] || c.kind}</span>
                    <span className="text-xs opacity-60 truncate" title={c.spec || ''}>
                      {c.dir ? `${c.dir}/` : 'repository root'}
                      {c.config ? ' · .narado' : ''}
                    </span>
                    {c.problem && (
                      <span className="text-xs truncate" style={{ color: 'var(--color-text-warning, #d4a106)' }} title={c.problem}>
                        {c.problem}
                      </span>
                    )}
                  </button>
                );
              })}
              {r.truncated && <div className="text-xs opacity-60">Very large repository: some folders may not be listed.</div>}
            </div>
          ))}
          {data && !data.scanning && !shown.length && (
            <div className="opacity-70">{filter ? 'No API matches that search.' : 'No repositories with collections found yet.'}</div>
          )}
        </div>

        {error && (
          <div className="text-sm" style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-explore-error">
            {error}
          </div>
        )}

        <div className="flex justify-between text-xs opacity-80">
          <span>Opening shows the default branch. Edits are saved to a branch or your fork when you choose.</span>
          <button type="button" className="underline" onClick={() => onMoreOptions && onMoreOptions(hostId, '')} data-testid="narado-explore-more">
            Open another repository…
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ExploreModal;
