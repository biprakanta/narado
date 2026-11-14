import { useState } from 'react';
import toast from 'react-hot-toast';
import Button from 'ui/Button';
import { naradoApi, errorText } from './api';

const STATUS_LABEL = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', '??': 'new' };

/**
 * The Git panel's body on the default branch. Edits there are local; saving them asks
 * where they go (a new branch in the repo, or the person's fork) and opens a merge
 * request into the default branch.
 */
const SaveChanges = ({ status, path, onSaved, onRefresh }) => {
  const [topic, setTopic] = useState('');
  const [message, setMessage] = useState('');
  const [via, setVia] = useState(status.saveVia[0] || 'branch');
  const [openMr, setOpenMr] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const changed = status.files.filter((f) => !f.conflicted);
  const main = status.defaultBranch;

  const save = async () => {
    setBusy('save');
    setError('');
    try {
      const res = await naradoApi.saveAsChange({ path, topic: topic.trim(), via, message: message.trim(), openMergeRequest: openMr });
      const where = res.via === 'fork' ? `your fork ${res.forkPath}` : status.repoPath;
      toast.success(`Saved to ${res.branch} in ${where}`);
      if (res.mergeRequest) {
        toast.success(`${status.hostType === 'github' ? 'Pull request' : 'Merge request'} #${res.mergeRequest.number} opened into ${main}`);
      }
      if (res.pushError) toast.error(`Saved on ${res.branch}, but the push failed: ${res.pushError}`, { duration: 10000 });
      if (res.mergeRequestError) toast.error(`Saved, but the merge request failed: ${res.mergeRequestError}`);
      onSaved(res);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const refreshMain = async () => {
    setBusy('pull');
    setError('');
    try {
      await naradoApi.pullDefault(path);
      toast.success(`Refreshed ${main}`);
      onRefresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const ready = !busy && changed.length > 0 && topic.trim() && message.trim() && status.saveVia.includes(via);

  return (
    <div className="flex flex-col gap-3" data-testid="narado-save-changes">
      <div className="opacity-80">
        {status.readOnly
          ? `You can look around ${main}, but you have read-only access and forking is turned off, so edits cannot be saved.`
          : `You are on ${main}. Edit freely; your edits stay on this server until you save them as a change, which goes to a new branch and a merge request into ${main}.`}
      </div>

      <div className="flex flex-col gap-1">
        <div className="font-medium">Changes ({changed.length})</div>
        {changed.length ? (
          changed.map((f) => (
            <div key={f.path} className="flex justify-between gap-2">
              <code className="truncate">{f.path}</code>
              <span className="opacity-70 shrink-0">{STATUS_LABEL[f.status] || f.status}</span>
            </div>
          ))
        ) : (
          <div className="opacity-70">No edits yet.</div>
        )}
      </div>

      {!status.readOnly && changed.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="narado-save-form">
          <div className="font-medium">Save changes</div>
          <input
            className="block textbox w-full"
            placeholder="Change name, for example: add refunds endpoint"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            data-testid="narado-save-topic"
          />
          <input
            className="block textbox w-full"
            placeholder="Describe the change (commit message)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="narado-save-message"
          />
          <div className="flex flex-col gap-1">
            <span className="opacity-80">Save to</span>
            {status.saveVia.includes('branch') && (
              <label className="flex items-center gap-2">
                <input type="radio" checked={via === 'branch'} onChange={() => setVia('branch')} data-testid="narado-save-via-branch" />
                A new branch in {status.repoPath}
              </label>
            )}
            {status.saveVia.includes('fork') && (
              <label className="flex items-center gap-2">
                <input type="radio" checked={via === 'fork'} onChange={() => setVia('fork')} data-testid="narado-save-via-fork" />
                A new branch in my fork (created if I do not have one)
              </label>
            )}
            {!status.saveVia.includes('branch') && (
              <span className="text-xs opacity-70">You have read-only access to {status.repoPath}, so changes go through your fork.</span>
            )}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={openMr} onChange={(e) => setOpenMr(e.target.checked)} data-testid="narado-save-open-mr" />
            Open a {status.hostType === 'github' ? 'pull request' : 'merge request'} into {main}
          </label>
          <div>
            <Button size="sm" disabled={!ready} onClick={save} data-testid="narado-save">
              {busy === 'save' ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={!!busy || changed.length > 0} onClick={refreshMain}>
          {busy === 'pull' ? 'Refreshing…' : `Refresh ${main}`}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={onRefresh}>
          Refresh status
        </Button>
      </div>

      {error && (
        <div style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
          {error}
        </div>
      )}
    </div>
  );
};

export default SaveChanges;
