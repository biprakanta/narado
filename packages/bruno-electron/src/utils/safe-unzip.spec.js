const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');
const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { safeUnzip, destinationOf } = require('./safe-unzip');

/** Write a zip whose entries are { name, content } files, { name, dir: true } or { name, link }. */
const makeZip = (file, entries) =>
  new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const e of entries) {
      if (e.link) zip.symlink(e.name, e.link);
      else if (e.dir) zip.append(null, { name: e.name.endsWith('/') ? e.name : `${e.name}/` });
      else zip.append(e.content, { name: e.name });
    }
    zip.finalize();
  });

describe('safeUnzip', () => {
  let tmp, dest, zipFile, outside;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-unzip-')));
    dest = path.join(tmp, 'dest');
    fs.mkdirSync(dest);
    zipFile = path.join(tmp, 'in.zip');
    outside = path.join(tmp, 'outside.txt');
    fs.writeFileSync(outside, 'original');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('unzips files and folders', async () => {
    await makeZip(zipFile, [
      { name: 'collection/', dir: true },
      { name: 'collection/bruno.json', content: '{"name":"c"}' },
      { name: 'collection/folder/req.bru', content: 'meta {}' }
    ]);
    await safeUnzip(zipFile, { dir: dest });
    expect(fs.readFileSync(path.join(dest, 'collection/bruno.json'), 'utf8')).toBe('{"name":"c"}');
    expect(fs.readFileSync(path.join(dest, 'collection/folder/req.bru'), 'utf8')).toBe('meta {}');
  });

  it('refuses a symlink that points outside', async () => {
    await makeZip(zipFile, [{ name: 'evil', link: '../outside.txt' }]);
    await expect(safeUnzip(zipFile, { dir: dest })).rejects.toThrow(/not a file or folder/);
    expect(fs.existsSync(path.join(dest, 'evil'))).toBe(false);
  });

  it('refuses a symlink followed by a file of the same name, and writes nothing outside', async () => {
    await makeZip(zipFile, [
      { name: 'x', link: '../outside.txt' },
      { name: 'x', content: 'pwned' }
    ]);
    await expect(safeUnzip(zipFile, { dir: dest })).rejects.toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('original');
  });

  it('refuses entry names that leave the folder', () => {
    expect(destinationOf(dest, '../outside.txt')).toBeNull();
    expect(destinationOf(dest, 'a/../../outside.txt')).toBeNull();
    expect(destinationOf(dest, '..\\outside.txt')).toBeNull();
    expect(destinationOf(dest, '/etc/passwd')).toBeNull();
    expect(destinationOf(dest, 'C:/Windows/x')).toBeNull();
    expect(destinationOf(dest, 'a/b.bru')).toBe(path.join(dest, 'a/b.bru'));
  });
});
