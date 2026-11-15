import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { naradoApi, errorText } from './api';
import SaveChanges from './SaveChanges';

const STATUS_LABEL = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', '??': 'new', 'UU': 'conflict' };
const REVIEW_LABEL = { approved: 'approved', changes_requested: 'changes requested', pending: 'awaiting review' };

/**
 * Git panel for one working copy: changes, commit, push, merge request,
 * update from the default branch and conflict resolution (design §7).
 */
// What applies to sends from narado desktop, by the organisation's policy (NARADO_DESKTOP_SEND).
const DESKTOP_RULES = {
  'any': ' On this computer, public hosts must be listed; private and local addresses (localhost, your network, VPN) don\'t need to be. Cloud metadata addresses are always refused.',
  'private-only': ' Your organisation lets narado desktop send only to private and local addresses (localhost, your network, VPN).',
  'allowlist-only': ' Your organisation lets narado desktop send only to hosts listed here, private ones included.'
};

const GitPanelModal = ({ path, onClose, onSwitch }) => {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [mrTitle, setMrTitle] = useState('');

  const [rules, setRules] = useState(null);

  const refresh = useCallback(async () => {
    naradoApi
      .requestRules(path)
      .then(setRules)
      .catch(() => setRules(null));
    try {
      setStatus(await naradoApi.status(path));
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  }, [path]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (label, fn, success) => {
    setBusy(label);
    setError('');
    try {
      const res = await fn();
      const msg = typeof success === 'function' ? success(res) : success;
      if (msg) toast.success(msg);
      await refresh();
      return res;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  };

  const rulesBlock = rules ? (
    <div className="flex flex-col gap-1 text-xs" data-testid="narado-request-rules">
      <div className="font-medium text-sm">Hosts this repo may send to</div>
      <div className="opacity-80">
        From {rules.branch || 'the default branch'}: <code>.narado/allowed-hosts.yml</code>, the spec's servers and URLs in environments. A host
        added on a branch counts once it is merged.
        {rules.desktop
          ? DESKTOP_RULES[rules.policy] || DESKTOP_RULES.any
          : rules.enforced
            ? ''
            : ' Not enforced on this server (single-user mode), except for MCP.'}
      </div>
      <div className="opacity-90" data-testid="narado-request-hosts">
        {rules.hosts.length ? rules.hosts.join(' · ') : rules.desktop && rules.policy !== 'allowlist-only' ? 'None yet: only private and local addresses can be reached.' : 'None yet: every request from this repo is refused.'}
      </div>
      {!rules.codeowners && (
        <div style={{ color: 'var(--color-text-warning, #e8590c)' }} data-testid="narado-codeowners-warning">
          CODEOWNERS doesn't cover every .narado/allowed-hosts.yml on {rules.branch || 'the default branch'}. Add one, and require code-owner review in
          branch protection, so that changes to the allowlist need approval.
        </div>
      )}
      {rules.codeowners && rules.codeOwnerReview === false && (
        <div style={{ color: 'var(--color-text-warning, #e8590c)' }} data-testid="narado-review-warning">
          {rules.branch || 'The default branch'} doesn't require code-owner review, so CODEOWNERS alone doesn't stop allowlist changes being merged
          without approval. Turn it on in the branch's protection rules.
        </div>
      )}
      {rules.codeowners && rules.codeOwnerReview === true && (
        <div style={{ color: 'var(--color-text-green, #2f9e44)' }} data-testid="narado-review-ok">
          Changes to the allowlist need code-owner approval on {rules.branch || 'the default branch'}.
        </div>
      )}
      {rules.codeowners && rules.codeOwnerReview === null && (
        <div className="opacity-80" data-testid="narado-review-unknown">
          narado can't see whether {rules.branch || 'the default branch'} requires code-owner review (that needs admin access on the host). Check it in
          the branch's protection rules.
        </div>
      )}
    </div>
  ) : null;

  if (!status) {
    return (
      <Modal size="md" title="Git" hideFooter handleCancel={onClose}>
        <div className="text-sm">{error || 'Loading…'}</div>
      </Modal>
    );
  }

  if (status.onDefaultBranch) {
    return (
      <Modal size="lg" title={`${status.repoPath} · ${status.branch}`} hideFooter handleCancel={onClose} dataTestId="narado-git-panel">
        <div className="text-sm" data-testid="narado-git">
          <SaveChanges status={status} path={path} onRefresh={refresh} onSaved={(res) => (onSwitch ? onSwitch(res.path) : onClose())} />
          <div className="mt-4">{rulesBlock}</div>
        </div>
      </Modal>
    );
  }

  const changed = status.files.filter((f) => !f.conflicted);
  const mr = status.mergeRequest;
  const canWrite = !status.readOnly;

  return (
    <Modal size="lg" title={`${status.repoPath} · ${status.branch}`} hideFooter handleCancel={onClose} dataTestId="narado-git-panel">
      <div className="flex flex-col gap-4 text-sm" data-testid="narado-git">
        <div className="flex flex-wrap gap-x-4 gap-y-1 opacity-80">
          <span>{status.hostName}</span>
          <span>Access: {status.access}</span>
          {status.via === 'fork' && (
            <span data-testid="narado-via-fork-label">Working in your fork{status.forkPath ? ` ${status.forkPath}` : ''}</span>
          )}
          {status.readOnly ? (
            <span>Read-only: {status.branch === status.defaultBranch ? `browsing ${status.defaultBranch}` : 'no write access'}</span>
          ) : (
            <>
              <span data-testid="narado-ahead-default">
                {status.aheadOfDefault} commit{status.aheadOfDefault === 1 ? '' : 's'} ahead of {status.defaultBranch}
              </span>
              <span data-testid="narado-behind-default">
                {status.behindDefault} behind {status.defaultBranch}
              </span>
              <span>{status.upstream ? (status.ahead ? `${status.ahead} not pushed` : 'pushed') : 'not pushed yet'}</span>
            </>
          )}
          <a href={status.repoUrl} target="_blank" rel="noreferrer">
            Open on {status.hostName}
          </a>
        </div>

        {status.merging && (
          <div className="flex flex-col gap-2 p-2 rounded" style={{ border: '1px solid rgba(217,83,79,.6)' }} data-testid="narado-conflicts">
            <div className="font-medium">
              Updating from {status.defaultBranch}:{' '}
              {status.conflicts.length ? `${status.conflicts.length} file(s) changed on both sides` : 'all conflicts resolved, commit to finish'}
            </div>
            {status.conflicts.map((f) => (
              <div key={f} className="flex items-center justify-between gap-2">
                <code className="truncate">{f}</code>
                <span className="flex gap-2 shrink-0">
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('resolve', () => naradoApi.resolve(path, f, 'mine'), `Kept your version of ${f}`)}>
                    Keep mine
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('resolve', () => naradoApi.resolve(path, f, 'theirs'), `Kept ${status.defaultBranch}'s version of ${f}`)}>
                    Keep {status.defaultBranch}
                  </Button>
                </span>
              </div>
            ))}
            <div>
              <Button size="sm" variant="ghost" color="danger" disabled={!!busy} onClick={() => run('abort', () => naradoApi.abortMerge(path), 'Update cancelled')}>
                Cancel the update
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="font-medium">
            Changes ({changed.length})
          </div>
          {changed.length ? (
            <div className="flex flex-col gap-1" data-testid="narado-changes">
              {changed.map((f) => (
                <div key={f.path} className="flex justify-between gap-2">
                  <code className="truncate">{f.path}</code>
                  <span className="opacity-70 shrink-0">{STATUS_LABEL[f.status] || f.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="opacity-70">No uncommitted changes.</div>
          )}
          {canWrite && (changed.length > 0 || (status.merging && !status.conflicts.length)) && (
            <div className="flex gap-2 items-center">
              <input
                className="block textbox flex-1"
                placeholder="Describe the change"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                data-testid="narado-commit-message"
              />
              <Button
                size="sm"
                disabled={!!busy || !message.trim() || status.conflicts.length > 0}
                onClick={async () => {
                  const res = await run('commit', () => naradoApi.commit(path, message), (r) => (r && r.sha ? `Committed ${r.sha}` : 'Nothing to commit'));
                  if (res) setMessage('');
                }}
                data-testid="narado-commit"
              >
                {busy === 'commit' ? 'Committing…' : 'Commit'}
              </Button>
            </div>
          )}
        </div>

        {canWrite && (
          <div className="flex flex-col gap-2">
            <div className="font-medium">Merge request</div>
            {mr ? (
              <div data-testid="narado-mr">
                <a href={mr.webUrl} target="_blank" rel="noreferrer">
                  {status.hostType === 'github' ? 'Pull request' : 'Merge request'} #{mr.number}: {mr.title}
                </a>{' '}
                {status.via === 'fork' && <span className="opacity-70">from your fork into {status.repoPath} </span>}
                <span className="opacity-70">
                  · {mr.state}
                  {mr.state === 'open' && mr.review ? ` · ${REVIEW_LABEL[mr.review] || mr.review}` : ''}
                </span>
              </div>
            ) : (
              <div className="flex gap-2 items-center">
                <input
                  className="block textbox flex-1"
                  placeholder={`Title (default: ${status.branch})`}
                  value={mrTitle}
                  onChange={(e) => setMrTitle(e.target.value)}
                  data-testid="narado-mr-title"
                />
                <Button
                  size="sm"
                  disabled={!!busy || changed.length > 0 || status.merging || status.aheadOfDefault === 0}
                  onClick={() => run('mr', () => naradoApi.createMergeRequest(path, mrTitle), (r) => `Opened #${r.number}`)}
                  data-testid="narado-open-mr"
                >
                  {busy === 'mr' ? 'Opening…' : 'Push and open'}
                </Button>
              </div>
            )}
            {status.mergeRequestError && <div className="opacity-70">Could not read merge request: {status.mergeRequestError}</div>}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <>
              <Button size="sm" variant="ghost" disabled={!!busy || changed.length > 0 || status.merging} onClick={() => run('push', () => naradoApi.push(path), (r) => `Pushed ${r.pushed} to ${r.to === 'fork' ? 'your fork' : status.repoPath}`)} data-testid="narado-push">
                {busy === 'push' ? 'Pushing…' : 'Push'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy || changed.length > 0 || status.merging}
                onClick={() =>
                  run('update', () => naradoApi.updateFromDefault(path), (r) =>
                    r.merged ? `Up to date with ${status.defaultBranch}` : null
                  )}
                data-testid="narado-update"
              >
                {busy === 'update' ? 'Updating…' : `Update from ${status.defaultBranch}`}
              </Button>
            </>
          )}
          {status.readOnly && status.branch === status.defaultBranch && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('pull', () => naradoApi.pullDefault(path), `Refreshed ${status.defaultBranch}`)}>
              {busy === 'pull' ? 'Refreshing…' : `Refresh ${status.defaultBranch}`}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={refresh}>
            Refresh status
          </Button>
        </div>

        {rulesBlock}

        {error && (
          <div style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default GitPanelModal;
