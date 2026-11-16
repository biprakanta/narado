/**
 * Folder listings for the browser's file dialogs (the stand-in for Electron's open and save
 * dialogs, see packages/bruno-app/src/components/Narado/ServerFileDialog.js).
 *
 * With sign-in on, a person may only browse their own folder: the worker's sandbox would let
 * it read narado's own code too, and that is no one's business. In single-user local mode the
 * server is the person's own machine, so the whole disk is open to them, starting at home.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ENTRIES = 2000;

const inside = (root, p) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

const resolveReal = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};

/**
 * @param {object} o
 * @param {string} [o.path]       folder to list; the starting folder when empty
 * @param {boolean} o.multiUser   sign-in is on: only `root` may be browsed
 * @param {string} o.root         the person's own folder (their data folder)
 * @param {string} [o.home]       where local mode starts
 * @returns {{ path: string, parent: string|null, root: string, entries: {name: string, dir: boolean}[], truncated: boolean }}
 */
const listFolder = ({ path: wanted, multiUser, root, home = os.homedir() }) => {
  const top = multiUser ? resolveReal(root) : path.parse(process.cwd()).root;
  if (!top) throw new Error('Your folder on the server is missing');
  const start = multiUser ? top : resolveReal(home) || top;

  let folder = wanted && String(wanted).trim() ? path.resolve(start, String(wanted).trim()) : start;
  // A file, or a folder that doesn't exist yet: show its nearest existing parent.
  for (;;) {
    const real = resolveReal(folder);
    let isDir = false;
    try {
      isDir = !!real && fs.statSync(real).isDirectory();
    } catch {
      // Refused by the sandbox, or gone: try the parent.
    }
    if (isDir) {
      folder = real;
      break;
    }
    const up = path.dirname(folder);
    if (up === folder) {
      folder = start;
      break;
    }
    folder = up;
  }
  if (!inside(top, folder)) throw new Error('That folder is outside your space on the server');

  const entries = [];
  let truncated = false;
  for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    let dir = d.isDirectory();
    if (d.isSymbolicLink()) {
      // Follow links only when they stay inside what may be browsed.
      const target = resolveReal(path.join(folder, d.name));
      if (!target || !inside(top, target)) continue;
      try {
        dir = fs.statSync(target).isDirectory();
      } catch {
        continue;
      }
    } else if (!dir && !d.isFile()) {
      continue;
    }
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ name: d.name, dir });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));

  const parent = folder === top ? null : path.dirname(folder);
  return { path: folder, parent, root: top, entries, truncated };
};

module.exports = { listFolder };
