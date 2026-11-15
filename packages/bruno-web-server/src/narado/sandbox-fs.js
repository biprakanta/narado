/**
 * File-system calls that Node's permission model refuses inside a sandboxed worker, which may
 * only read and write the person's own folder (see workers.js). Applied by worker.js before
 * any Bruno code loads.
 */

/** @param {typeof import('node:fs')} fs */
const patchForSandbox = (fs) => {
  // fsync is refused outright, and the settings library Bruno uses calls it on every write.
  // Writes still happen; only the forced flush to disk is skipped.
  for (const name of ['fsync', 'fdatasync']) {
    fs[`${name}Sync`] = () => {};
    fs[name] = (fd, cb) => process.nextTick(cb, null);
    if (fs.promises) fs.promises[name] = async () => {};
  }
  // fs.realpath (the callback form) resolves paths in JavaScript, checking every parent folder
  // from /, and the sandbox refuses those outside the person's folder. The file watcher Bruno
  // uses calls it on Linux (macOS watches through FSEvents), so every collection watcher
  // failed there, then climbed to / and looped. The native form resolves in one system call
  // that only checks the path itself.
  const native = fs.realpath.native;
  const realpath = (p, options, cb) => (typeof options === 'function' ? native(p, options) : native(p, options, cb));
  realpath.native = native;
  fs.realpath = realpath;
};

module.exports = { patchForSandbox };
