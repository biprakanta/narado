import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IconArrowUp, IconFile, IconFolder } from '@tabler/icons';
import Modal from 'components/Modal';
import { errorText } from './api';

/**
 * The browser's stand-in for Electron's open and save dialogs: browse folders on the server
 * (packages/bruno-web-server/src/narado/browse.js) instead of typing a path into a prompt.
 *
 * `request` is what the server asked for: { kind: 'open' | 'save', title, defaultPath,
 * properties, filters }. `onDone` gets Electron's result shape.
 */

const sepOf = (p) => (p && p.includes('\\') && !p.includes('/') ? '\\' : '/');
const join = (folder, name) => (folder.endsWith(sepOf(folder)) ? folder + name : folder + sepOf(folder) + name);
const baseName = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() || '' : '');

/** Electron filters: [{ name, extensions: ['json', '*'] }]. */
const matchesFilters = (name, filters) => {
  const exts = (filters || []).flatMap((f) => f.extensions || []);
  if (!exts.length || exts.includes('*')) return true;
  const lower = name.toLowerCase();
  return exts.some((e) => lower.endsWith(`.${String(e).toLowerCase()}`));
};

const listServerFolder = (path) => window.ipcRenderer.invoke('narado:list-folder', { path });

const ServerFileDialog = ({ request, onDone, listFolder = listServerFolder }) => {
  const props = request.properties || [];
  const saving = request.kind === 'save';
  const wantsFolder = !saving && props.includes('openDirectory');
  const wantsFiles = !saving && (props.includes('openFile') || !wantsFolder);
  const multi = props.includes('multiSelections');

  const [listing, setListing] = useState(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState([]);
  const [fileName, setFileName] = useState(saving ? baseName(request.defaultPath) : '');

  const go = useCallback(
    async (path) => {
      try {
        const out = await listFolder(path);
        setListing(out);
        setTyped(out.path);
        setSelected([]);
        setError(null);
      } catch (err) {
        setError(errorText(err));
      }
    },
    [listFolder]
  );

  useEffect(() => {
    // Saving: defaultPath names the file, so start in its folder.
    const start = request.defaultPath || '';
    go(saving && baseName(start) ? start.slice(0, start.length - baseName(start).length).replace(/(.)[\\/]$/, '$1') : start);
  }, [go, request.defaultPath, saving]);

  const entries = useMemo(
    () => (listing ? listing.entries.filter((e) => e.dir || (wantsFiles || saving ? matchesFilters(e.name, request.filters) : false)) : []),
    [listing, wantsFiles, saving, request.filters]
  );

  const cancel = () => onDone(saving ? { canceled: true } : { canceled: true, filePaths: [] });

  const confirm = () => {
    if (!listing) return;
    if (saving) {
      const name = fileName.trim();
      if (name) onDone({ canceled: false, filePath: join(listing.path, name) });
      return;
    }
    if (selected.length) {
      onDone({ canceled: false, filePaths: selected.map((n) => join(listing.path, n)) });
    } else if (wantsFolder) {
      onDone({ canceled: false, filePaths: [listing.path] });
    }
  };

  const pick = (entry) => {
    if (entry.dir) {
      go(join(listing.path, entry.name));
      return;
    }
    if (saving) {
      setFileName(entry.name);
      return;
    }
    if (!wantsFiles) return;
    setSelected((cur) => (multi ? (cur.includes(entry.name) ? cur.filter((n) => n !== entry.name) : [...cur, entry.name]) : [entry.name]));
  };

  const ready = !!listing && (saving ? !!fileName.trim() : selected.length > 0 || wantsFolder);
  const confirmText = saving ? 'Save' : selected.length ? 'Open' : wantsFolder ? 'Choose this folder' : 'Open';
  const title = request.title || (saving ? 'Save as' : wantsFolder ? 'Choose a folder' : 'Choose a file');

  return (
    <Modal
      size="md"
      title={title}
      confirmText={confirmText}
      handleConfirm={confirm}
      handleCancel={cancel}
      confirmDisabled={!ready}
      dataTestId="narado-file-dialog"
    >
      <div className="flex flex-col gap-2 text-sm">
        <div className="flex gap-2 items-center">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!listing || !listing.parent}
            onClick={() => go(listing.parent)}
            title="Up one folder"
            aria-label="Up one folder"
            data-testid="narado-file-dialog-up"
          >
            <IconArrowUp size={14} />
          </button>
          <input
            className="textbox flex-1"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                go(typed);
              }
            }}
            spellCheck={false}
            aria-label="Folder on the server"
            data-testid="narado-file-dialog-path"
          />
        </div>

        {error && (
          <div className="text-red-500" role="alert" data-testid="narado-file-dialog-error">
            {error}
          </div>
        )}

        <ul
          className="border rounded overflow-auto"
          style={{ height: 280, listStyle: 'none', margin: 0, padding: 4, borderColor: 'var(--color-border, rgba(127,127,127,.25))' }}
          data-testid="narado-file-dialog-list"
        >
          {listing && !entries.length && <li className="opacity-60 p-2">This folder is empty.</li>}
          {entries.map((e) => {
            const isSelected = !e.dir && (selected.includes(e.name) || (saving && fileName === e.name));
            const disabled = !e.dir && !wantsFiles && !saving;
            return (
              <li key={e.name}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-2 py-1 rounded text-left"
                  style={{
                    opacity: disabled ? 0.45 : 1,
                    cursor: disabled ? 'default' : 'pointer',
                    background: isSelected ? 'rgba(251,155,26,.16)' : 'transparent'
                  }}
                  onClick={() => pick(e)}
                  onDoubleClick={() => !e.dir && !disabled && !saving && onDone({ canceled: false, filePaths: [join(listing.path, e.name)] })}
                  disabled={disabled}
                  data-testid={`narado-file-dialog-entry-${e.name}`}
                >
                  {e.dir ? <IconFolder size={16} stroke={1.5} /> : <IconFile size={16} stroke={1.5} />}
                  <span className="truncate">{e.name}</span>
                </button>
              </li>
            );
          })}
          {listing && listing.truncated && <li className="opacity-60 p-2">Showing the first 2,000 entries.</li>}
        </ul>

        {saving && (
          <label className="flex flex-col gap-1">
            <span>File name</span>
            <input
              className="textbox"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              spellCheck={false}
              data-testid="narado-file-dialog-name"
            />
          </label>
        )}
        {wantsFolder && !selected.length && listing && (
          <div className="opacity-70" data-testid="narado-file-dialog-hint">
            Open a folder to look inside it, then choose it.
          </div>
        )}
      </div>
    </Modal>
  );
};

/**
 * Mounted once in the app. The web bridge (src/web-bridge.js) calls
 * window.__naradoServerDialog when the server asks for an open or save dialog; one at a time.
 */
export const ServerFileDialogHost = () => {
  const [active, setActive] = useState(null); // { request, resolve }

  useEffect(() => {
    if (typeof window === 'undefined' || !window.isBrunoWeb) return undefined;
    const queue = [];
    let busy = false;
    const next = () => {
      if (busy || !queue.length) return;
      busy = true;
      const item = queue.shift();
      setActive({
        request: item.request,
        resolve: (result) => {
          setActive(null);
          busy = false;
          item.resolve(result);
          next();
        }
      });
    };
    window.__naradoServerDialog = (request) =>
      new Promise((resolve) => {
        queue.push({ request, resolve });
        next();
      });
    return () => {
      delete window.__naradoServerDialog;
    };
  }, []);

  if (!active) return null;
  return <ServerFileDialog request={active.request} onDone={active.resolve} />;
};

export default ServerFileDialog;
