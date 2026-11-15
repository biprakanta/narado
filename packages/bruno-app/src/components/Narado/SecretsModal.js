import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { IconFolder, IconLock } from '@tabler/icons';
import Modal from 'components/Modal';
import Button from 'ui/Button';
import { naradoApi, errorText } from './api';

const call = (ch, ...args) => window.ipcRenderer.invoke(ch, ...args);
const refFor = (store, path, field) => `secret://${store}/${path}${field ? `#${field}` : ''}`;

/**
 * Browse the secrets stores this server is connected to and copy references to paste into
 * an environment variable. Values never come to the browser: the server swaps a reference
 * for its value when a request is sent, and masks it in what it shows back.
 */
const SecretsModal = ({ onClose }) => {
  const [stores, setStores] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [wsPath, setWsPath] = useState('');
  const [store, setStore] = useState('');
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState([]);
  const [picked, setPicked] = useState(null);
  const [field, setField] = useState('');
  const [check, setCheck] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([call('narado:secrets:stores'), naradoApi.workspaces().catch(() => [])])
      .then(([s, w]) => {
        setStores(s);
        setWorkspaces(w);
        if (s.length) setStore(s[0].id);
        if (w.length) setWsPath(w[0].path);
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  const load = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError('');
    try {
      setEntries(await call('narado:secrets:list', store, prefix, wsPath || null));
    } catch (err) {
      setEntries([]);
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [store, prefix, wsPath]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPicked(null);
    setCheck(null);
  }, [store, prefix, wsPath]);

  const ref = picked ? refFor(store, picked.path, field.trim()) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref);
      toast.success('Reference copied. Paste it as an environment variable value.');
    } catch {
      toast.error('Copy failed; select the text and copy it');
    }
  };

  const runCheck = async () => {
    setCheck({ pending: true });
    try {
      setCheck(await call('narado:secrets:check', ref, wsPath || null));
    } catch (err) {
      setCheck({ ok: false, error: errorText(err) });
    }
  };

  const crumbs = prefix ? prefix.split('/') : [];
  const current = stores && stores.find((s) => s.id === store);

  return (
    <Modal size="lg" title="Secrets" hideFooter handleCancel={onClose} dataTestId="narado-secrets">
      <div className="flex flex-col gap-3 text-sm">
        <div className="opacity-80">
          Secrets stay in your organisation's secrets store. Put a reference such as <code>secret://vault/payments/staging#api_key</code> in an
          environment variable; it goes into Git, and narado's server swaps it for the value only when it sends the request.
        </div>

        {stores && stores.length === 0 && <div className="opacity-70">No secrets stores are set up on this server. See the server README, "Secrets".</div>}

        {stores && stores.length > 0 && (
          <>
            <div className="flex gap-2 items-center flex-wrap">
              <label className="flex items-center gap-1">
                Store
                <select className="textbox" value={store} onChange={(e) => (setStore(e.target.value), setPrefix(''))} data-testid="narado-secrets-store">
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id} ({s.type}{s.configured ? '' : ', not connected'})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 min-w-0">
                For
                <select className="textbox min-w-0" value={wsPath} onChange={(e) => setWsPath(e.target.value)} data-testid="narado-secrets-workspace">
                  {workspaces.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.repoPath} ({w.branch})
                    </option>
                  ))}
                  <option value="">A collection outside Git</option>
                </select>
              </label>
            </div>
            {current && (
              <div className="text-xs opacity-70">
                {current.perPerson
                  ? `${current.id} signs in as you, so its own policies decide what you can read.`
                  : `${current.id} uses a service identity; narado's access rules decide which paths each repo and person may use.`}
              </div>
            )}

            <div className="flex gap-1 items-center text-xs" data-testid="narado-secrets-crumbs">
              <button type="button" className="underline" onClick={() => setPrefix('')}>{store}</button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  {' / '}
                  <button type="button" className="underline" onClick={() => setPrefix(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                </span>
              ))}
            </div>

            <div className="flex flex-col rounded" style={{ border: '1px solid rgba(127,127,127,.3)', maxHeight: 220, overflow: 'auto' }} data-testid="narado-secrets-list">
              {loading && <div className="px-2 py-1 opacity-70">Loading…</div>}
              {!loading && entries.length === 0 && !error && <div className="px-2 py-1 opacity-70">Nothing here that you may use.</div>}
              {entries.map((e) => (
                <button
                  type="button"
                  key={e.path}
                  className="text-left px-2 py-1 flex items-center gap-2"
                  style={picked && picked.path === e.path ? { background: 'rgba(232,89,12,.15)' } : undefined}
                  onClick={() => (e.folder ? setPrefix(e.path) : (setPicked(e), setCheck(null)))}
                  data-testid="narado-secrets-entry"
                >
                  {e.folder ? <IconFolder size={14} stroke={1.5} /> : <IconLock size={14} stroke={1.5} />}
                  <span className="truncate">{e.name}</span>
                </button>
              ))}
            </div>

            {picked && (
              <div className="flex flex-col gap-2" data-testid="narado-secrets-picked">
                <label className="flex items-center gap-2">
                  Field
                  <input className="textbox" placeholder="optional, for example api_key" value={field} onChange={(e) => (setField(e.target.value), setCheck(null))} data-testid="narado-secrets-field" />
                </label>
                <div className="flex gap-2 items-center">
                  <code className="flex-1 truncate" data-testid="narado-secrets-ref">{ref}</code>
                  <Button size="sm" variant="ghost" onClick={runCheck} data-testid="narado-secrets-check">Check</Button>
                  <Button size="sm" onClick={copy} data-testid="narado-secrets-copy">Copy reference</Button>
                </div>
                {check && (
                  <div className="text-xs" data-testid="narado-secrets-check-result" style={{ color: check.pending ? undefined : check.ok ? 'var(--color-text-green, #2f9e44)' : 'var(--color-text-danger, #d9534f)' }}>
                    {check.pending ? 'Checking…' : check.ok ? `You can use this here (${check.length} characters). The value is not shown.` : check.error}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {error && (
          <div style={{ color: 'var(--color-text-danger, #d9534f)' }} data-testid="narado-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default SecretsModal;
