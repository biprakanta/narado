#!/usr/bin/env node
/**
 * Package the `narado` command (packages/bruno-web-server/bin/narado.js) so it runs outside
 * this repository.
 *
 *   node scripts/build-narado-cli.js [--no-binary]
 *
 * Output in packages/bruno-web-server/dist-cli/ (never committed):
 *
 *   narado.js                    the command in one file, for any system with Node 20 or later
 *                                (`node narado.js login`)
 *   narado-cli-<version>.tgz     an npm package of it: `npm install -g narado-cli-<version>.tgz`
 *                                puts `narado` on the PATH
 *   narado-<os>-<arch>[.exe]     a single executable with Node inside, for this system
 *                                (Node's single executable applications); no Node needed
 *
 * The desktop release workflow builds the executable on macOS, Windows and Linux and adds all
 * of these to the GitHub release.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'packages/bruno-web-server');
const OUT = path.join(SERVER, 'dist-cli');
const version = require(path.join(SERVER, 'package.json')).version;
const noBinary = process.argv.includes('--no-binary');

const step = (text) => console.log(`\n[narado] ${text}`);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && !path.isAbsolute(cmd), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

step('Bundling the narado command into one file');
const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
const bundle = path.join(OUT, 'narado.js');
esbuild.buildSync({
  entryPoints: [path.join(SERVER, 'bin/narado.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: bundle,
  legalComments: 'none',
  logLevel: 'warning'
});
// Keep the shebang first (esbuild keeps it) and say which version this is.
fs.chmodSync(bundle, 0o755);

step('Making the npm package');
const pkgDir = path.join(OUT, 'package');
fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
fs.copyFileSync(bundle, path.join(pkgDir, 'bin/narado.js'));
fs.writeFileSync(
  path.join(pkgDir, 'package.json'),
  JSON.stringify(
    {
      name: 'narado-cli',
      version,
      description: "narado's command line: sign in with your organisation's SSO and run tools with the team's secrets",
      bin: { narado: 'bin/narado.js' },
      engines: { node: '>=20' },
      license: 'UNLICENSED',
      private: true
    },
    null,
    2
  ) + '\n'
);
fs.writeFileSync(
  path.join(pkgDir, 'README.md'),
  `# narado-cli ${version}\n\nInstall: \`npm install -g narado-cli-${version}.tgz\`\n\n\`\`\`\nnarado login https://narado.example.com\nnarado run -- npm start\nnarado check\nnarado whoami\nnarado logout\n\`\`\`\n`
);
run('npm', ['pack', '--silent', '--pack-destination', OUT], { cwd: pkgDir });
fs.rmSync(pkgDir, { recursive: true, force: true });

if (!noBinary) {
  const os = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] || process.platform;
  const exe = path.join(OUT, `narado-${os}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
  step(`Making the single executable for ${os} (${process.arch}) with Node ${process.version}`);
  const seaConfig = path.join(OUT, 'sea-config.json');
  const [major, minor] = process.versions.node.split('.').map(Number);
  const builtIn = major > 25 || (major === 25 && minor >= 5); // node --build-sea
  if (builtIn) {
    fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: exe, disableExperimentalSEAWarning: true, useCodeCache: false }));
    run(process.execPath, ['--build-sea', seaConfig]);
  } else {
    // Older Node: make the blob, copy node, and inject it with postject.
    const blob = path.join(OUT, 'sea-prep.blob');
    fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
    run(process.execPath, ['--experimental-sea-config', seaConfig]);
    fs.copyFileSync(process.execPath, exe);
    fs.chmodSync(exe, 0o755);
    if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);
    const args = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
    if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
    run('npx', args);
    fs.rmSync(blob, { force: true });
  }
  fs.rmSync(seaConfig, { force: true });
  // macOS only runs signed executables on Apple silicon: sign it for this computer (ad hoc).
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', '--force', exe]);
  // It must start.
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.includes(version)) throw new Error(`The executable didn't start: ${r.stderr || r.stdout}`);
  console.log(`[narado] ${path.basename(exe)} says ${r.stdout.trim()}`);
}

step(`Done: ${fs.readdirSync(OUT).join(', ')} in ${path.relative(ROOT, OUT)}/`);
