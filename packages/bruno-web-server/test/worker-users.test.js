const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { WorkerUsers } = require('../src/narado/worker-users');
const { WorkerPool } = require('../src/narado/workers');

const quiet = { log() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'narado-wu-'));
const FAKE = path.join(__dirname, 'fixtures', 'fake-worker.js');
const ROOT = process.platform === 'linux' && process.getuid && process.getuid() === 0;

test('each person gets a fixed system user of their own, kept across restarts', () => {
  const dataDir = tmp();
  const wu = new WorkerUsers({ dataDir, log: quiet });
  const a = wu.idFor('alice');
  const b = wu.idFor('bob');
  assert.equal(a, 200000);
  assert.equal(b, 200001);
  assert.equal(new WorkerUsers({ dataDir, log: quiet }).idFor('alice'), a, 'the same after a restart');
  assert.throws(() => wu.idFor('../etc'), /Unexpected user id/);
  assert.equal(new WorkerUsers({ dataDir: tmp(), env: { NARADO_WORKER_UID_BASE: '300000' }, log: quiet }).idFor('x'), 300000);
  assert.throws(() => new WorkerUsers({ dataDir, env: { NARADO_WORKER_UID_BASE: '0' } }), /NARADO_WORKER_UID_BASE/);
});

test('it refuses to start where it cannot keep the promise', () => {
  const dataDir = tmp();
  assert.match(new WorkerUsers({ dataDir, os: { platform: 'darwin', getuid: () => 0 } }).cannot(), /Linux only/);
  assert.match(new WorkerUsers({ dataDir, os: { platform: 'linux', getuid: () => 1000 } }).cannot(), /needs the front to run as root/);
  assert.equal(new WorkerUsers({ dataDir, os: { platform: 'linux', getuid: () => 0 } }).cannot(), null);
  if (!ROOT) {
    assert.throws(() => new WorkerPool({ dataDir, multiUser: true, publicPort: 1, rpc: async () => [], env: { NARADO_WORKER_USERS: '1' }, log: quiet }), /NARADO_WORKER_USERS=1/);
  }
});

test("a person's folder is handed over to their user, links untouched; shared folders can be passed through, not listed", () => {
  const dataDir = tmp();
  const owned = [];
  const wu = new WorkerUsers({ dataDir, os: { platform: 'linux', getuid: () => 0, lchown: (p, uid, gid) => owned.push([path.relative(dataDir, p), uid, gid]) }, log: quiet });
  fs.writeFileSync(path.join(dataDir, 'narado.json'), '{}', { mode: 0o600 });
  const dir = path.join(dataDir, 'users', 'alice');
  fs.mkdirSync(path.join(dir, 'git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'git', 'file'), 'x');
  fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
  assert.deepEqual(wu.prepare('alice', dir), { uid: 200000, gid: 200000 });
  assert.deepEqual(owned.map(([p]) => p).sort(), ['users/alice', 'users/alice/git', 'users/alice/git/file', 'users/alice/link'].sort());
  assert.ok(owned.every(([, u, g]) => u === 200000 && g === 200000));
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dataDir, 'users')), 0o711);
  assert.equal(mode(dataDir), 0o711);
  assert.equal(mode(path.join(dataDir, 'narado.json')), 0o644);
  // A folder that is itself a link is refused.
  const elsewhere = tmp();
  fs.symlinkSync(elsewhere, path.join(dataDir, 'users', 'mallory'));
  assert.throws(() => wu.prepare('mallory', path.join(dataDir, 'users', 'mallory')), /is a link/);
});

// The real thing: only as root on Linux (CI's Docker check, or `sudo node --test` on a Linux box).
test('as root on Linux: workers run as their own users and cannot read each other\'s folders', { skip: !ROOT && 'needs root on Linux' }, async () => {
  const dataDir = tmp();
  const pool = new WorkerPool({ dataDir, multiUser: true, publicPort: 1, rpc: async () => [], script: FAKE, sandbox: false, env: { ...process.env, NARADO_WORKER_USERS: '1' }, log: quiet });
  try {
    const a = await pool.get({ id: 'alice' });
    const b = await pool.get({ id: 'bob' });
    const ask = (entry, p) =>
      new Promise((resolve, reject) =>
        http.get({ host: '127.0.0.1', port: entry.port, path: p, headers: { 'x-narado-worker': entry.secret } }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve(JSON.parse(t)));
        }).on('error', reject)
      );
    const ia = await ask(a, '/whoami');
    const ib = await ask(b, '/whoami');
    assert.equal(ia.uid, 200000);
    assert.equal(ib.uid, 200001);
    assert.deepEqual(ia.groups, [200000], 'no supplementary groups');
    fs.writeFileSync(path.join(dataDir, 'users', 'bob', 'secret.txt'), 'bob only', { mode: 0o600 });
    fs.lchownSync(path.join(dataDir, 'users', 'bob', 'secret.txt'), 200001, 200001);
    const peek = await ask(a, `/read?path=${encodeURIComponent(path.join(dataDir, 'users', 'bob', 'secret.txt'))}`);
    assert.match(peek.error, /EACCES/, 'alice cannot read bob\'s file');
    const own = await ask(a, `/write?path=${encodeURIComponent(path.join(dataDir, 'users', 'alice', 'mine.txt'))}`);
    assert.equal(own.ok, true, 'alice can write her own folder');
    const front = await ask(a, `/read?path=${encodeURIComponent(path.join(dataDir, 'worker-uids.json'))}`);
    assert.match(front.error, /EACCES/, "the front's files are not the workers'");
  } finally {
    pool.stopAll();
  }
});
