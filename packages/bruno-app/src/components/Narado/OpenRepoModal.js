import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import { naradoApi, errorText } from './api';

const ACCESS_LABEL = { read: 'Read', write: 'Write', admin: 'Admin', none: 'No access' };

/**
 * Pick a Git host and repo, then either start a change (new branch), open an
 * existing branch, or browse the default branch read-only.
 */
const OpenRepoModal = ({ onClose, onOpened }) => {
  const [hosts, setHosts] = useState([]);
  const [hostId, setHostId] = useState('');
  const [repos, setRepos] = useState([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [filter, setFilter] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [mode, setMode] = useState('change'); // change | branch | browse
  const [topic, setTopic] = useState('');
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  useEffect(() => {
    if (!hostId) return;
    setLoadingRepos(true);
    setRepos([]);
    setRepoPath('');
    setError('');
    naradoApi
      .repos(hostId)
      .then(setRepos)
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoadingRepos(false));
  }, [hostId]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return repos.filter((r) => !f || r.path.toLowerCase().includes(f)).slice(0, 200);
  }, [repos, filter]);

  const selected = repos.find((r) => r.path === repoPath);
  const canEdit = selected && ['write', 'admin'].includes(selected.access);
  const effectiveMode = canEdit ? mode : 'browse';

  const ready
    = selected
      && !busy
      && (effectiveMode === 'browse' || (effectiveMode === 'change' && topic.trim()) || (effectiveMode === 'branch' && branch.trim()));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      const args = { hostId, repoPath };
      if (effectiveMode === 'change') args.topic = topic.trim();
      if (effectiveMode === 'branch') args.branch = branch.trim();
      let ws = await naradoApi.open(args);
      if (!ws.collections.length && !ws.readOnly) {
        const ok = window.confirm(`${repoPath} has no collection yet. Create one at the root of the repo?`);
        if (ok) {
          const res = await naradoApi.initCollection(ws.path, selected.name);
          ws = { ...ws, collections: res.collections };
        }
      }
      if (!ws.collections.length) {
        toast(`Opened ${repoPath} on ${ws.branch}, but it has no collection.`);
      } else {
        toast.success(`Opened ${repoPath} on ${ws.branch}`);
      }
      onOpened && onOpened(ws);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const connected = hosts.filter((h) => h.connected);
  const notConnected = hosts.filter((h) => !h.connected);

  return (
    <Modal
      size="md"
      title="Open from Git"
      confirmText={busy ? 'Opening…' : 'Open'}
      handleConfirm={submit}
      handleCancel={onClose}
      confirmDisabled={!ready}
      dataTestId="narado-open-repo-modal"
    >
      <div className="flex flex-col gap-3" data-testid="narado-open-repo">
        {hosts.length > 0 && !connected.length && (
          <div className="text-sm">
            No Git host is connected. Set a token on the server, for example{' '}
            <code>{notConnected.map((h) => h.tokenEnv).join(' or ')}</code>, then restart it.
          </div>
        )}

        {connected.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Git host</span>
            <select className="block textbox w-full" value={hostId} onChange={(e) => setHostId(e.target.value)} data-testid="narado-host">
              {connected.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
            {notConnected.length > 0 && (
              <span className="text-xs opacity-70">
                Not connected: {notConnected.map((h) => `${h.name} (${h.tokenEnv})`).join(', ')}
              </span>
            )}
          </label>
        )}

        {hostId && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Repository</span>
            <input
              className="block textbox w-full"
              placeholder={loadingRepos ? 'Loading repositories…' : `Search ${repos.length} repositories`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              data-testid="narado-repo-filter"
              autoFocus
            />
            <div className="border rounded overflow-auto" style={{ maxHeight: 220, borderColor: 'var(--color-border, rgba(127,127,127,.3))' }}>
              {shown.map((r) => (
                <button
                  type="button"
                  key={r.path}
                  onClick={() => setRepoPath(r.path)}
                  className="w-full text-left px-2 py-1 flex justify-between gap-2"
                  style={{ background: r.path === repoPath ? 'rgba(127,127,127,.2)' : 'transparent' }}
                  data-testid={`narado-repo-${r.path}`}
                >
                  <span className="truncate">{r.path}</span>
                  <span className="text-xs opacity-70 shrink-0">
                    {r.private ? 'private · ' : ''}
                    {ACCESS_LABEL[r.access] || r.access}
                  </span>
                </button>
              ))}
              {!loadingRepos && !shown.length && <div className="px-2 py-1 opacity-70">No repositories found</div>}
            </div>
          </div>
        )}

        {selected && (
          <div className="flex flex-col gap-2 text-sm">
            {canEdit ? (
              <>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mode === 'change'} onChange={() => setMode('change')} />
                  Start a change (new branch from {selected.defaultBranch})
                </label>
                {mode === 'change' && (
                  <input
                    className="block textbox w-full"
                    placeholder="Short name, for example: add refunds endpoint"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submit()}
                    data-testid="narado-topic"
                  />
                )}
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mode === 'branch'} onChange={() => setMode('branch')} />
                  Open an existing branch
                </label>
                {mode === 'branch' && (
                  <input
                    className="block textbox w-full"
                    placeholder="Branch name"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    data-testid="narado-branch"
                  />
                )}
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mode === 'browse'} onChange={() => setMode('browse')} />
                  Browse {selected.defaultBranch} (read-only)
                </label>
              </>
            ) : (
              <div className="opacity-80">You have read-only access, so {selected.defaultBranch} opens for browsing.</div>
            )}
          </div>
        )}

        {error && (
          <div className="text-sm" style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default OpenRepoModal;
