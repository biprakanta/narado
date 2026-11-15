#!/usr/bin/env node
/**
 * Build narado desktop's installers (desktop phase D4).
 *
 *   node scripts/build-narado-desktop.js [--mac|--win|--linux] [--arch arm64|x64|arm64,x64] [--skip-web] [--dir]
 *
 * 1. Builds the interface (narado's brand) and copies it into packages/bruno-electron/web,
 *    with its paths made relative for loading from files.
 * 2. Bundles narado's desktop code (packages/bruno-web-server/src/desktop.js and what it
 *    uses, with its dependencies) into packages/bruno-electron/narado/desktop.js, and copies
 *    narado's icons and version there.
 * 3. Runs electron-builder with electron-builder-narado.js. Installers land in
 *    packages/bruno-electron/out-narado/.
 *
 * --dir makes the app folder only (quicker, for trying it); --skip-web reuses the last
 * interface build. Defaults: this computer's system and chip. .github/workflows/narado-desktop-release.yml
 * runs it for each system and publishes a GitHub release.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'packages/bruno-electron');
const WEB_OUT = path.join(ELECTRON, 'web');
const NARADO_OUT = path.join(ELECTRON, 'narado');
const BRANDING = path.join(ROOT, 'branding/icons');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const target = flag('--mac') ? 'mac' : flag('--win') ? 'win' : flag('--linux') ? 'linux' : { darwin: 'mac', win32: 'win' }[process.platform] || 'linux';
const archs = (value('--arch') || (process.arch === 'arm64' ? 'arm64' : 'x64')).split(',');
if (archs.some((a) => !['arm64', 'x64'].includes(a))) throw new Error(`--arch takes arm64, x64 or both (arm64,x64)`);

const step = (text) => console.log(`\n[narado] ${text}`);
const run = (cmd, cmdArgs, opts = {}) => {
  // npm and npx are .cmd files on Windows, which only run through a shell.
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status})`);
};

/** The interface, built with narado's brand, made loadable from files. */
const APP_SRC = path.join(ROOT, 'packages/bruno-app/src');
/** A hash of the interface's source, kept with each build to tell whether it's stale. */
const sourceHash = () => {
  const hash = require('node:crypto').createHash('sha256');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else hash.update(path.relative(APP_SRC, p)).update(fs.readFileSync(p));
    }
  };
  walk(APP_SRC);
  return hash.digest('hex');
};

const buildInterface = () => {
  const dist = path.join(ROOT, 'packages/bruno-app/dist');
  const stamp = path.join(dist, '.narado-source');
  if (!flag('--skip-web')) {
    step('Building the interface');
    run('npm', ['run', 'build:web'], { env: { ...process.env, BRUNO_BRAND: 'narado' } });
    fs.writeFileSync(stamp, sourceHash());
  }
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('No interface build in packages/bruno-app/dist; run without --skip-web');
  // Reusing an interface build made from other source would ship the old interface.
  if (flag('--skip-web') && (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== sourceHash())) {
    throw new Error('The interface changed since its last build (or the build is from before this check); run without --skip-web');
  }
  step('Copying the interface into the app');
  fs.rmSync(WEB_OUT, { recursive: true, force: true });
  fs.cpSync(dist, WEB_OUT, { recursive: true });
  // Absolute paths (/static/..., /narado/...) don't work from files: make them relative.
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(WEB_OUT)) {
    if (file.endsWith('.map')) {
      fs.rmSync(file);
      continue;
    }
    if (!/\.(html|js|css)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let next = text;
    if (file.endsWith('.html')) next = next.replace(/(["'(])\/(static|narado)\//g, '$1./$2/');
    else if (file.endsWith('.css')) next = next.replace(/\/static\/font/g, '../../static/font').replace(/url\(\/narado\//g, 'url(../../narado/');
    else next = next.replace(/(["'`])\/narado\//g, '$1./narado/');
    if (next !== text) fs.writeFileSync(file, next);
  }
};

/** narado's desktop code in one file, with its icons and version. */
const bundleNarado = () => {
  step("Bundling narado's desktop code");
  fs.rmSync(NARADO_OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(NARADO_OUT, 'assets'), { recursive: true });
  const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'packages/bruno-web-server/src/desktop.js')],
    outfile: path.join(NARADO_OUT, 'desktop.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // What Bruno's desktop app already ships (chokidar with its native parts, Bruno's own
    // packages, ...) loads from the app's modules; only what it lacks gets bundled.
    external: ['electron', ...Object.keys(require(path.join(ELECTRON, 'package.json')).dependencies || {}).flatMap((d) => [d, `${d}/*`])],
    metafile: true,
    logLevel: 'warning',
    banner: { js: '// narado desktop: bundled by scripts/build-narado-desktop.js from packages/bruno-web-server/src. Do not edit.' }
  });
  // Server-only modules that find files next to themselves must not end up here.
  const inputs = Object.keys(result.metafile.inputs);
  const serverOnly = inputs.filter((f) => /bruno-web-server\/src\/narado\/(workers|pages|admin|auth)\.js$/.test(f));
  if (serverOnly.length) throw new Error(`Server-only modules reached the desktop bundle: ${serverOnly.join(', ')}`);
  for (const f of ['app-icon-512.png', 'narado-illustration-256.png']) fs.copyFileSync(path.join(BRANDING, f), path.join(NARADO_OUT, 'assets', f));
  if (process.platform === 'darwin') {
    // The macOS icon, from the app icon.
    const set = path.join(os.tmpdir(), `narado-${process.pid}.iconset`);
    fs.mkdirSync(set, { recursive: true });
    const src = path.join(BRANDING, 'app-icon-512.png');
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync('sips', ['-z', String(size), String(size), src, '--out', path.join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
      if (size * 2 <= 512) execFileSync('sips', ['-z', String(size * 2), String(size * 2), src, '--out', path.join(set, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(NARADO_OUT, 'assets', 'icon.icns')]);
    fs.rmSync(set, { recursive: true, force: true });
  }
  const versions = { narado: require(path.join(ROOT, 'packages/bruno-web-server/package.json')).version, bruno: require(path.join(ELECTRON, 'package.json')).version, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(NARADO_OUT, 'version.json'), JSON.stringify(versions, null, 2));
  console.log(`[narado] desktop.js ${(fs.statSync(path.join(NARADO_OUT, 'desktop.js')).size / 1024).toFixed(0)} KB from ${inputs.length} files; narado ${versions.narado} on Bruno ${versions.bruno}`);
};

const packageApp = () => {
  step(`Packaging for ${target} (${archs.join(', ')})${flag('--dir') ? ', app folder only' : ''}`);
  // The chips go to electron-builder-narado.js, whose targets list them.
  const builderArgs = [`--${target}`, '--config', 'electron-builder-narado.js', '--publish', 'never'];
  if (flag('--dir')) builderArgs.push('--dir');
  run('npx', ['electron-builder', ...builderArgs], { cwd: ELECTRON, env: { ...process.env, NARADO_ARCHS: archs.join(',') } });
  const out = path.join(ELECTRON, 'out-narado');
  console.log(`\n[narado] Done: ${out}`);
  for (const f of fs.readdirSync(out)) if (/\.(dmg|zip|exe|AppImage|deb|yml)$/.test(f)) console.log(`  ${f}`);
  if (!flag('--dir')) writeUpdates(out);
};

/**
 * The folder a narado server serves updates from: out-narado/updates/<mac|win|linux>/ with the
 * installers and latest.json (version, and each file's chip, kind, size and SHA-512). Copy it
 * to <data dir>/desktop-updates/<mac|win|linux>/ on the server.
 */
const writeUpdates = (out) => {
  const crypto = require('node:crypto');
  const version = require(path.join(ROOT, 'packages/bruno-web-server/package.json')).version;
  const platform = target;
  const kinds = { mac: ['dmg'], win: ['exe'], linux: ['AppImage', 'deb'] }[platform];
  const dir = path.join(out, 'updates', platform);
  fs.mkdirSync(dir, { recursive: true });
  const manifestFile = path.join(dir, 'latest.json');
  let manifest = { version, files: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (prev.version === version) manifest = prev; // keep the other chip's files from an earlier run
  } catch {}
  const name = new RegExp(`^narado_${version.replace(/\./g, '\\.')}_(arm64|x64|x86_64|amd64|aarch64)_(mac|win|linux)\\.(${kinds.join('|')})$`);
  const archOf = (a) => ({ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64' })[a] || a;
  for (const f of fs.readdirSync(out)) {
    const m = name.exec(f);
    if (!m) continue;
    const data = fs.readFileSync(path.join(out, f));
    const entry = { name: f, arch: archOf(m[1]), kind: m[3], size: data.length, sha512: crypto.createHash('sha512').update(data).digest('base64') };
    manifest.files = [...manifest.files.filter((x) => x.name !== f), entry];
    fs.copyFileSync(path.join(out, f), path.join(dir, f));
  }
  manifest.version = version;
  manifest.publishedAt = new Date().toISOString();
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`[narado] Updates for ${platform}: ${dir} (${manifest.files.map((x) => `${x.arch} ${x.kind}`).join(', ') || 'no installers found'}).`);
  console.log(`[narado] Put that folder's files in <narado data dir>/desktop-updates/${platform}/ on the server.`);
};

try {
  buildInterface();
  bundleNarado();
  packageApp();
} catch (err) {
  console.error(`\n[narado] Build failed: ${err.message}`);
  process.exit(1);
}
