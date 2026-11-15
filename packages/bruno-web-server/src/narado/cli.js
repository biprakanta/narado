/**
 * The `narado` command (bin/narado.js): use a team's secrets in local tools, as yourself.
 *
 *   narado login [server]        sign in with your organisation's SSO (the browser opens), as a
 *                                device listed under Devices, like narado desktop
 *   narado run [-e .env] [--repo github:acme/api] -- <command> [args]
 *                                start a command with the .env file's values, secret:// ones
 *                                fetched from narado
 *   narado check [-e .env]       which secret:// values in .env you can use here (no values shown)
 *   narado whoami | logout
 *
 * In .env, a value that is a whole reference is fetched, for example
 *
 *   STRIPE_KEY=secret://vault-svc/payments/staging#stripe
 *
 * narado decides as you: secrets an environment of this repository references (its default
 * branch) are yours if you can read the repository, and admins' access rules cover the rest.
 * The repository comes from `git remote get-url origin` (or --repo). Values are only ever
 * in the started command's environment: never written to disk or printed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { RemoteFront, normaliseServer } = require('./desktop-front');
const { parseRef } = require('./secrets/refs');

const ACCOUNT = 'session';
const SERVICE = 'narado-cli';
const MARK = 'os-keychain:v1';
// NAME=secret://store/path#field (optionally quoted, optionally `export`, then a comment).
const REF_LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(["']?)(secret:\/\/[A-Za-z0-9_-]+\/[^\s"'#]+(?:#[^\s"']+)?)\2[ \t]*(?:#.*)?$/gm;

/**
 * Electron's safeStorage, for a command line: the token goes to the OS's secure storage where
 * there is one (macOS Keychain, Linux secret service); otherwise a file only you can read.
 */
const osSecureStorage = ({ platform = process.platform, run = execFileSync } = {}) => {
  const has = (cmd) => {
    try {
      run('/usr/bin/env', ['which', cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  // NARADO_CLI_STORAGE=file: a file only you can read (machines without a keychain, CI).
  const fileOnly = process.env.NARADO_CLI_STORAGE === 'file';
  const mac = !fileOnly && platform === 'darwin' && has('security');
  const linux = !fileOnly && platform === 'linux' && has('secret-tool');
  return {
    kind: mac ? 'macOS Keychain' : linux ? 'secret service' : 'a file only you can read',
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      if (mac) {
        run('security', ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-w', text], { stdio: 'ignore' });
        return Buffer.from(MARK);
      }
      if (linux) {
        run('secret-tool', ['store', '--label=narado CLI', 'service', SERVICE, 'account', ACCOUNT], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
        return Buffer.from(MARK);
      }
      return Buffer.from(`plain:${text}`);
    },
    decryptString: (buf) => {
      const s = String(buf);
      if (s.startsWith('plain:')) return s.slice(6);
      if (s !== MARK) throw new Error('unknown saved sign-in');
      if (mac) return String(run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'])).trim();
      if (linux) return String(run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT])).trim();
      throw new Error("this computer's secure storage isn't available");
    }
  };
};

const dataDirDefault = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'narado');

const openBrowser = (url) => {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {}
};

/** The repository a folder's Git remote points at, as narado names it: { hostId, repoPath }. */
const repoOf = (cwd, hosts = [], run = execFileSync) => {
  let remote = '';
  try {
    remote = String(run('git', ['remote', 'get-url', 'origin'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch {
    return null;
  }
  // https://github.com/acme/api.git, git@github.com:acme/api.git, ssh://git@host:22/group/sub/repo.git
  const m = /^(?:https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|[^@\s]+@([^:]+):)(.+?)(?:\.git)?\/?$/.exec(remote);
  if (!m) return null;
  const hostname = (m[1] || m[2] || m[3]).toLowerCase();
  const repoPath = m[4];
  const known = hosts.length ? hosts : [{ id: 'github', type: 'github' }, { id: 'gitlab', type: 'gitlab', url: 'https://gitlab.com' }];
  const host = known.find((h) => {
    const url = h.url || (h.type === 'github' ? 'https://github.com' : 'https://gitlab.com');
    try {
      return new URL(url).hostname.toLowerCase() === hostname;
    } catch {
      return false;
    }
  });
  return host ? { hostId: host.id, repoPath } : null;
};

/** --repo github:acme/api */
const parseRepoArg = (s) => {
  const m = /^([\w-]+):(.+)$/.exec(String(s || ''));
  return m ? { hostId: m[1], repoPath: m[2] } : null;
};

/** The .env files' variables (later files win), and which values are secret references. */
const readEnvFiles = (files, { required = false } = {}) => {
  const dotenv = require('dotenv');
  const vars = {};
  for (const f of files) {
    if (!fs.existsSync(f)) {
      if (required) throw new Error(`${f} doesn't exist`);
      continue;
    }
    const text = fs.readFileSync(f, 'utf8');
    Object.assign(vars, dotenv.parse(text));
    // dotenv treats an unquoted # as a comment, which would cut a reference's #field: take
    // reference values straight from their lines, quoted or not.
    for (const m of text.matchAll(REF_LINE)) vars[m[1]] = m[3];
  }
  const refs = Object.entries(vars)
    .filter(([, v]) => parseRef(v))
    .map(([name, v]) => ({ name, ref: v.trim() }));
  return { vars, refs };
};

/** The values for the references, as the signed-in person: { values: {NAME: value}, failed: [{name, ref, error}] }. */
const resolveRefs = async (front, refs, repo) => {
  if (!refs.length) return { values: {}, failed: [] };
  const res = await front.secrets.resolve(
    refs.map((r) => r.ref),
    repo || {}
  );
  const got = (res && res.values) || {};
  const errors = (res && res.errors) || {};
  const values = {};
  const failed = [];
  for (const r of refs) {
    if (r.ref in got) values[r.name] = got[r.ref];
    else failed.push({ ...r, error: errors[r.ref] || 'not available' });
  }
  return { values, failed };
};

const USAGE = `narado: use your team's secrets in local tools, as yourself.

  narado login [server] [--no-browser]
                                 sign in with SSO (opens your browser, or prints the link)
  narado run [options] -- <command> [args]
                                 run a command with .env's values; secret:// ones come from narado
  narado check [options]         which secret:// values in .env you can use here (no values shown)
  narado whoami                  who you're signed in as, and where
  narado logout                  sign this computer's narado command out

Options for run and check:
  -e, --env-file <file>          .env file to read (repeatable; default .env)
  --repo <host:owner/repo>       the repository whose bound secrets apply (default: git remote origin)
`;

const parseArgs = (argv) => {
  const out = { envFiles: [], repo: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a === '-e' || a === '--env-file') out.envFiles.push(argv[++i]);
    else if (a.startsWith('--env-file=')) out.envFiles.push(a.slice(11));
    else if (a === '--repo') out.repo = argv[++i];
    else if (a.startsWith('--repo=')) out.repo = a.slice(7);
    else out.rest.push(a);
  }
  return out;
};

/** Run the command line; returns the exit code. `io` carries what tests replace. */
const main = async (argv, io = {}) => {
  // --no-browser: print the sign-in link instead of opening a browser (SSH, remote machines).
  const noBrowser = argv.includes('--no-browser');
  argv = argv.filter((a) => a !== '--no-browser');
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  const dataDir = io.dataDir || dataDirDefault();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const storage = io.safeStorage || osSecureStorage();
  const front =
    io.front ||
    new RemoteFront({
      dataDir,
      safeStorage: storage,
      openExternal: (url) => {
        if (noBrowser) return err(`Open this link in a browser to sign in:\n  ${url}`);
        err(`Opening your browser to sign in. If it doesn't open, go to:\n  ${url}`);
        openBrowser(url);
      },
      deviceName: `${os.hostname()} (narado CLI)`,
      log: { log() {}, warn: (m) => err(m), error: (m) => err(m) }
    });
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return out(USAGE), cmd ? 0 : 2;

  if (cmd === 'login') {
    const server = rest[0] || process.env.NARADO_SERVER_URL || front.server;
    if (!server) return err('Which narado server? narado login https://narado.example.com'), 2;
    const s = await front.signIn(normaliseServer(server));
    out(`Signed in to ${s.server} as ${s.user ? `${s.user.name} (${s.user.email})` : 'you'}. Your sign-in is kept in ${storage.kind}.`);
    return 0;
  }
  if (cmd === 'logout') {
    await front.signOut();
    out('Signed out.');
    return 0;
  }
  if (cmd === 'whoami') {
    if (!front.signedIn) return err('Not signed in. Run: narado login <server>'), 1;
    const s = await front.loadSession().catch(() => front.session);
    out(`${s.user ? `${s.user.name} (${s.user.email})` : 'Signed in'} on ${front.server}${s.device ? `, as "${s.device.name}"` : ''}`);
    return 0;
  }

  if (cmd === 'run' || cmd === 'check') {
    const args = parseArgs(rest);
    if (cmd === 'run' && !args.rest.length) return err('What should run? narado run -- npm test'), 2;
    const files = args.envFiles.length ? args.envFiles : ['.env'];
    const { vars, refs } = readEnvFiles(files, { required: args.envFiles.length > 0 });
    if (refs.length && !front.signedIn) return err(`${files.join(', ')} uses secrets: sign in first with narado login <server>`), 1;
    if (refs.length && !front.session?.hosts) await front.loadSession().catch(() => {});
    const repo = args.repo ? parseRepoArg(args.repo) : repoOf(io.cwd || process.cwd(), (front.session && front.session.hosts) || [], io.run);
    if (args.repo && !repo) return err('--repo looks like github:acme/payments-api'), 2;
    const { values, failed } = await resolveRefs(front, refs, repo);
    const where = repo ? `${repo.hostId}:${repo.repoPath}` : 'no repository';

    if (cmd === 'check') {
      for (const r of refs) out(`${values[r.name] !== undefined ? 'ok  ' : 'no  '} ${r.name}  ${r.ref}${values[r.name] === undefined ? `  (${failed.find((f) => f.name === r.name).error})` : ''}`);
      out(`${refs.length - failed.length} of ${refs.length} secret value(s) available, for ${where}.`);
      return failed.length ? 1 : 0;
    }
    if (failed.length) {
      for (const f of failed) err(`narado: ${f.name} (${f.ref}): ${f.error}`);
      err(`narado: not starting ${args.rest[0]}: ${failed.length} secret value(s) unavailable for ${where}.`);
      return 1;
    }
    const child = (io.spawn || spawn)(args.rest[0], args.rest.slice(1), { stdio: 'inherit', env: { ...process.env, ...vars, ...values } });
    return new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve(code === null ? (signal ? 128 : 1) : code));
      child.on('error', (e) => {
        err(`narado: couldn't start ${args.rest[0]}: ${e.message}`);
        resolve(127);
      });
    });
  }

  err(`Unknown command: ${cmd}\n\n${USAGE}`);
  return 2;
};

module.exports = { main, osSecureStorage, repoOf, readEnvFiles, resolveRefs, parseRepoArg, parseArgs };
