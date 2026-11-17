#!/usr/bin/env node
/**
 * Start the packaged narado desktop in its check mode and report (desktop phase D5).
 *
 *   node scripts/narado-desktop-smoke.js
 *
 * Finds the app folder electron-builder made in packages/bruno-electron/out-narado for this
 * system, starts it with NARADO_DESKTOP_SMOKE=1 and a fresh data folder, and fails unless
 * every check passes (see packages/bruno-web-server/src/narado/desktop-smoke.js). On Linux
 * it needs a display: CI runs it under xvfb-run.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUT = path.resolve(__dirname, '../packages/bruno-electron/out-narado');
const candidates = {
  darwin: [`mac-${process.arch}/narado.app/Contents/MacOS/narado`, 'mac-arm64/narado.app/Contents/MacOS/narado', 'mac/narado.app/Contents/MacOS/narado'],
  win32: ['win-unpacked/narado.exe', 'win-arm64-unpacked/narado.exe'],
  linux: ['linux-unpacked/narado', 'linux-arm64-unpacked/narado']
}[process.platform];
const exe = (candidates || []).map((c) => path.join(OUT, c)).find((p) => fs.existsSync(p));
if (!exe) {
  console.error(`[narado] No packaged app in ${OUT} for ${process.platform}; build it first (scripts/build-narado-desktop.js --dir)`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narado-smoke-'));
const report = path.join(dir, 'report.json');
const env = {
  ...process.env,
  NARADO_DESKTOP: '1',
  NARADO_DESKTOP_SMOKE: '1',
  NARADO_DESKTOP_SMOKE_REPORT: report,
  // A fresh data folder: never the person's own narado data.
  ELECTRON_USER_DATA_PATH: path.join(dir, 'user-data')
};
delete env.NARADO_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
// CI's Linux has no setuid sandbox helper for an unpacked app.
const args = process.platform === 'linux' ? ['--no-sandbox'] : [];

console.log(`[narado] starting ${path.relative(process.cwd(), exe)} in check mode`);
const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
const timer = setTimeout(() => {
  console.error('[narado] the app did not finish its checks within 3 minutes');
  child.kill();
}, 180000);
// Once the report is written the checks are done: give the app 20 s to quit on its own,
// then stop it (its result is in the report either way).
let quitTimer = null;
let stopped = false;
const watch = setInterval(() => {
  if (quitTimer || !fs.existsSync(report)) return;
  quitTimer = setTimeout(() => {
    console.log('[narado] the app wrote its report but did not quit within 20 s; stopping it');
    stopped = true;
    child.kill();
  }, 20000);
}, 1000);
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  clearInterval(watch);
  clearTimeout(quitTimer);
  if (!fs.existsSync(report)) {
    console.error(`[narado] no report (exit ${code}). The app's output:\n${output.slice(-6000)}`);
    process.exit(1);
  }
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  for (const c of r.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}${c.error ? `: ${c.error}` : ''}`);
  console.log(`[narado] ${r.platform} ${r.arch}, Electron ${r.electron}: ${r.ok ? 'all checks passed' : 'checks failed'}`);
  if (!r.ok) console.error(output.slice(-6000));
  try {
    // Electron's helper processes can still be writing here after a forced stop.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.log(`[narado] left ${dir} behind (${err.code})`);
  }
  // The report decides: the checks ran in the app. How it ended afterwards (a forced stop, or
  // a helper crashing on CI's macOS while quitting) is reported but doesn't fail the check.
  if (code !== 0) console.log(`[narado] warning: the app ended with ${signal ? `signal ${signal}` : `exit ${code}`}${stopped ? ' (stopped by this script)' : ''}`);
  process.exit(r.ok ? 0 : 1);
});
