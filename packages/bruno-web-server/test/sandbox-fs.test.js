const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs code under Node's permission model with read and write only in `folder`, like a
// sandboxed worker, with or without narado's patches.
const sandboxed = (folder, patched, code) => {
  const setup = patched ? `require(${JSON.stringify(require.resolve('../src/narado/sandbox-fs'))}).patchForSandbox(require('node:fs'));` : '';
  const r = spawnSync(
    process.execPath,
    ['--permission', `--allow-fs-read=${folder}`, `--allow-fs-read=${path.resolve(__dirname, '../src')}`, `--allow-fs-write=${folder}`, '-e', setup + code],
    { encoding: 'utf8' }
  );
  return r.stdout.trim();
};

test('fs.realpath works inside the sandbox, as the Linux file watcher needs', () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'narado-sandbox-')));
  const file = path.join(folder, 'collection.yml');
  fs.writeFileSync(file, 'x');
  const code = `
    const fs = require('node:fs');
    fs.realpath(${JSON.stringify(file)}, (err, p) => console.log(err ? err.code : p));`;
  try {
    // Without the patch Node's JavaScript realpath checks every parent folder and is refused.
    assert.equal(sandboxed(folder, false, code), 'ERR_ACCESS_DENIED');
    assert.equal(sandboxed(folder, true, code), file);
    // Options and .native still work.
    assert.equal(sandboxed(folder, true, `const fs = require('node:fs'); fs.realpath(${JSON.stringify(file)}, 'utf8', (e, p) => console.log(p, typeof fs.realpath.native));`), `${file} function`);
    // Outside the folder is still refused.
    assert.equal(sandboxed(folder, true, `require('node:fs').realpath(${JSON.stringify(os.homedir())}, (e) => console.log(e && e.code));`), 'ERR_ACCESS_DENIED');
    // fsync is a no-op rather than refused.
    assert.equal(sandboxed(folder, true, `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(file)}, 'r+'); fs.fsyncSync(fd); fs.fsync(fd, (e) => console.log(e || 'ok'));`), 'ok');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
