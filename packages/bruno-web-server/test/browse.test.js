const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listFolder } = require('../src/narado/browse');

const setup = () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'narado-browse-')));
  const root = path.join(tmp, 'person');
  fs.mkdirSync(path.join(root, 'collections/petstore'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Beta'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(root, '.hidden'), 'x');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'x');
  return { tmp, root };
};

test('lists folders first, then files, without hidden entries', () => {
  const { root } = setup();
  const out = listFolder({ multiUser: true, root });
  assert.equal(out.path, root);
  assert.equal(out.parent, null);
  assert.deepEqual(out.entries, [
    { name: 'Beta', dir: true },
    { name: 'collections', dir: true },
    { name: 'notes.txt', dir: false }
  ]);
});

test('with sign-in on, refuses folders outside the person\'s own', () => {
  const { tmp, root } = setup();
  assert.throws(() => listFolder({ path: tmp, multiUser: true, root }), /outside your space/);
  assert.throws(() => listFolder({ path: path.join(root, '../..'), multiUser: true, root }), /outside your space/);
  assert.equal(listFolder({ path: 'collections', multiUser: true, root }).path, path.join(root, 'collections'));
});

test('with sign-in on, skips links that lead outside', () => {
  const { tmp, root } = setup();
  fs.symlinkSync(tmp, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'collections'), path.join(root, 'shortcut'));
  const names = listFolder({ multiUser: true, root }).entries.map((e) => e.name);
  assert.ok(!names.includes('escape'));
  assert.ok(names.includes('shortcut'));
});

test('a file or a missing folder shows its nearest existing folder', () => {
  const { root } = setup();
  assert.equal(listFolder({ path: path.join(root, 'notes.txt'), multiUser: true, root }).path, root);
  assert.equal(listFolder({ path: path.join(root, 'collections/new/deeper'), multiUser: true, root }).path, path.join(root, 'collections'));
});

test('in local mode, starts at home and may go anywhere', () => {
  const { tmp, root } = setup();
  const out = listFolder({ multiUser: false, root, home: root });
  assert.equal(out.path, root);
  assert.equal(out.parent, path.dirname(root));
  assert.equal(listFolder({ path: tmp, multiUser: false, root, home: root }).path, tmp);
});
