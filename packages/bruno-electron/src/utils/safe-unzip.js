/**
 * Unzip an archive someone imported (a collection or a workspace) into a fresh folder, safely.
 *
 * extract-zip, which this replaces, writes symlink entries as symlinks and follows them for
 * later entries, so a crafted zip could read or write files outside the folder (GHSA advisories
 * against extract-zip <= 2.0.1, with no fixed release). Collections and workspaces are plain
 * files, so this refuses symlinks and anything else that is not a file or a folder, refuses
 * names that leave the folder, and never writes through an existing link.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Where an entry would land, or null when its name leaves dir. */
const destinationOf = (dir, name) => {
  const clean = String(name).replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || clean.includes('\0')) return null;
  if (clean.split('/').some((part) => part === '..')) return null;
  const target = path.resolve(dir, clean);
  return target === dir || target.startsWith(dir + path.sep) ? target : null;
};

/** The kind an entry claims to be: 'dir', 'file', or 'other' (symlinks, devices and the like). */
const kindOf = (entry) => {
  const isDirName = entry.fileName.endsWith('/') || entry.fileName.endsWith('\\');
  const madeOnUnix = entry.versionMadeBy >> 8 === 3;
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
  if (madeOnUnix && mode) {
    if (mode === S_IFDIR) return 'dir';
    if (mode === S_IFREG) return isDirName ? 'dir' : 'file';
    return 'other';
  }
  return isDirName ? 'dir' : 'file';
};

/** Refuse when any folder between dir and target is a link (we never make one, but be sure). */
const assertNoLinks = (dir, target) => {
  let current = dir;
  for (const part of path.relative(dir, target).split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refused a zip entry inside a link: ${part}`);
    }
  }
};

const openZip = (file) =>
  new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (err, zip) =>
      err ? reject(err) : resolve(zip)
    )
  );

const openStream = (zip, entry) =>
  new Promise((resolve, reject) => zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream))));

/** Unzip file into dir (an existing, empty folder). Rejects, leaving dir partly filled, on a bad entry. */
const safeUnzip = async (file, { dir }) => {
  const root = fs.realpathSync(path.resolve(dir));
  const zip = await openZip(file);
  try {
    await new Promise((resolve, reject) => {
      const fail = (err) => {
        zip.close();
        reject(err);
      };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        (async () => {
          const target = destinationOf(root, entry.fileName);
          if (!target) throw new Error(`Refused a zip entry outside the folder: ${entry.fileName}`);
          const kind = kindOf(entry);
          if (kind === 'other') throw new Error(`Refused a zip entry that is not a file or folder: ${entry.fileName}`);
          assertNoLinks(root, target);
          if (kind === 'dir') {
            fs.mkdirSync(target, { recursive: true });
            return;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
            throw new Error(`Refused a zip entry over a link: ${entry.fileName}`);
          }
          const stream = await openStream(zip, entry);
          await pipeline(stream, fs.createWriteStream(target, { flags: 'w', mode: 0o644 }));
        })().then(() => zip.readEntry(), fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
};

module.exports = { safeUnzip, destinationOf, kindOf };
