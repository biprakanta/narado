import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { naradoApi, errorText } from './api';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

/**
 * Personal MCP tokens. A token lets an AI assistant use narado as the person who made it;
 * write tokens can also edit requests, commit, push and open merge requests.
 */
const McpTokensModal = ({ onClose }) => {
  const [info, setInfo] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState('read');
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [i, t] = await Promise.all([naradoApi.mcpInfo(), naradoApi.mcpTokens()]);
      setInfo(i);
      setTokens(t);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await naradoApi.createMcpToken(name.trim(), scope);
      setCreated(res);
      setName('');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t) => {
    if (!window.confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
    try {
      await naradoApi.revokeMcpToken(t.id);
      toast.success(`Revoked "${t.name}"`);
      if (created && created.record.id === t.id) setCreated(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed; select the text and copy it');
    }
  };

  const command = created && info ? `claude mcp add --transport http narado ${info.url} --header "Authorization: Bearer ${created.token}"` : '';

  return (
    <Modal size="lg" title="MCP tokens" hideFooter handleCancel={onClose} dataTestId="narado-mcp-tokens">
      <div className="flex flex-col gap-4 text-sm">
        <div className="opacity-80">
          AI assistants connect to narado over MCP at <code>{info ? info.url : '…'}</code>. Each token acts as you: it can only see and do what
          you can, merge requests it opens say they came from it, and it stops working if narado is connected to a different Git account.
        </div>

        {created && (
          <div className="flex flex-col gap-2 p-2 rounded" style={{ border: '1px solid rgba(127,127,127,.4)' }} data-testid="narado-mcp-new-token">
            <div className="font-medium">Token for "{created.record.name}". Copy it now; it will not be shown again.</div>
            <div className="flex gap-2 items-center">
              <code className="flex-1 truncate" data-testid="narado-mcp-token-value">{created.token}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(created.token)}>Copy</Button>
            </div>
            <div className="opacity-80">To add it to Claude Code:</div>
            <div className="flex gap-2 items-center">
              <code className="flex-1 truncate">{command}</code>
              <Button size="sm" variant="ghost" onClick={() => copy(command)}>Copy</Button>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2" data-testid="narado-mcp-create">
          <div className="font-medium">New token</div>
          <input
            className="block textbox w-full"
            placeholder="What will use it, for example: Claude Code on my laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="narado-mcp-token-name"
          />
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === 'read'} onChange={() => setScope('read')} data-testid="narado-mcp-scope-read" />
            Read: list and read requests and specs, send requests to the hosts a workspace names
          </label>
          <label className="flex items-center gap-2" style={{ opacity: info && !info.writeAllowed ? 0.5 : 1 }}>
            <input type="radio" checked={scope === 'write'} disabled={info && !info.writeAllowed} onChange={() => setScope('write')} data-testid="narado-mcp-scope-write" />
            Read and write: also edit requests, commit, push and open merge requests as you
            {info && !info.writeAllowed ? ' (turned off on this server)' : ''}
          </label>
          <div>
            <Button size="sm" disabled={busy || !name.trim()} onClick={create} data-testid="narado-mcp-create-btn">
              {busy ? 'Creating…' : 'Create token'}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="font-medium">Your tokens ({tokens.length})</div>
          {tokens.length === 0 && <div className="opacity-70">None yet.</div>}
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2" data-testid="narado-mcp-token-row">
              <span className="flex flex-col min-w-0">
                <span className="truncate">
                  {t.name} <span className="opacity-70">· {t.scope === 'write' ? 'read and write' : 'read'} · {t.hint}</span>
                </span>
                <span className="text-xs opacity-70 truncate">
                  As {Object.entries(t.owner.hosts).map(([h, l]) => `${l} on ${h}`).join(', ')} · created {when(t.createdAt)} · last used {when(t.lastUsedAt)}
                </span>
              </span>
              <Button size="sm" variant="ghost" color="danger" onClick={() => revoke(t)}>Revoke</Button>
            </div>
          ))}
        </div>

        {error && (
          <div style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default McpTokensModal;
