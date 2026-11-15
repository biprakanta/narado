const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { main } = require('../src/narado/cli');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'narado-cli-'));

/** A signed-in front whose server knows two secrets; records what was asked. */
const fakeFront = (known = { 'secret://svc/payments/staging#stripe': 'sk_test_1' }) => {
  const asked = [];
  return {
    asked,
    signedIn: true,
    server: 'https://narado.acme.com',
    session: { hosts: [{ id: 'github', type: 'github' }] },
    loadSession: async () => ({}),
    secrets: {
      resolve: async (refs, ctx) => {
        asked.push({ refs, ctx });
        const values = {};
        const errors = {};
        for (const r of refs) if (r in known) values[r] = known[r];
        else errors[r] = 'You may not use it here';
        return { values, errors };
      }
    }
  };
};

const capture = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(s), err: (s) => lines.push(s) };
};

test("narado run: starts the command with .env's values, secret:// ones fetched for this repository", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'API_URL=https://staging.acme.com\nSTRIPE_KEY=secret://svc/payments/staging#stripe\n');
  const front = fakeFront();
  const io = capture();
  let started = null;
  const spawn = (cmd, args, opts) => {
    started = { cmd, args, env: opts.env };
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  };
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const code = await main(['run', '--', 'npm', 'test'], { ...io, front, spawn, dataDir: tmp(), safeStorage: {}, run: () => 'git@github.com:acme/payments.git' });
    assert.equal(code, 0);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(started.cmd, 'npm');
  assert.deepEqual(started.args, ['test']);
  assert.equal(started.env.STRIPE_KEY, 'sk_test_1');
  assert.equal(started.env.API_URL, 'https://staging.acme.com');
  assert.deepEqual(front.asked, [{ refs: ['secret://svc/payments/staging#stripe'], ctx: { hostId: 'github', repoPath: 'acme/payments' } }]);
  assert.ok(!io.lines.join('\n').includes('sk_test_1'), 'values are never printed');
});

test("narado run: doesn't start the command when a secret isn't available, and says which", async () => {
  const dir = tmp();
  const env = path.join(dir, 'ci.env');
  fs.writeFileSync(env, 'STRIPE_KEY=secret://svc/payments/staging#stripe\nPROD_KEY=secret://svc/payments/prod#stripe\n');
  const io = capture();
  let started = false;
  const code = await main(['run', '-e', env, '--repo', 'github:acme/payments', '--', 'deploy'], { ...io, front: fakeFront(), spawn: () => (started = true), dataDir: tmp(), safeStorage: {} });
  assert.equal(code, 1);
  assert.equal(started, false);
  assert.match(io.lines.join('\n'), /PROD_KEY \(secret:\/\/svc\/payments\/prod#stripe\): You may not use it here/);
  assert.match(io.lines.join('\n'), /not starting deploy: 1 secret value\(s\) unavailable for github:acme\/payments/);
});

test('narado check: lists what you can use here, never the values', async () => {
  const dir = tmp();
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'STRIPE_KEY=secret://svc/payments/staging#stripe\nPROD_KEY=secret://svc/payments/prod#stripe\nPLAIN=1\n');
  const io = capture();
  const code = await main(['check', '-e', env, '--repo', 'github:acme/payments'], { ...io, front: fakeFront(), dataDir: tmp(), safeStorage: {} });
  assert.equal(code, 1);
  const text = io.lines.join('\n');
  assert.match(text, /^ok {3}STRIPE_KEY {2}secret:\/\/svc\/payments\/staging#stripe$/m);
  assert.match(text, /^no {3}PROD_KEY/m);
  assert.match(text, /1 of 2 secret value\(s\) available, for github:acme\/payments\./);
  assert.ok(!text.includes('sk_test_1'));
});

test('narado run: not signed in, with secrets in .env', async () => {
  const dir = tmp();
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'K=secret://svc/x\n');
  const io = capture();
  const code = await main(['run', '-e', env, '--', 'true'], { ...io, front: { ...fakeFront(), signedIn: false }, dataDir: tmp(), safeStorage: {} });
  assert.equal(code, 1);
  assert.match(io.lines.join('\n'), /sign in first with narado login/);
});
