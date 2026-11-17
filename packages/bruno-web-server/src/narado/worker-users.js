/**
 * One system user per person (NARADO_WORKER_USERS=1, Linux).
 *
 * Node's permission model already keeps each worker to its own folder. This adds the
 * operating system's own wall: each person's worker runs as a user and group of its own, so
 * even code that got past Node's sandbox (a bug in Node, a native module) is refused by the
 * kernel when it reaches for another person's files or signals their processes.
 *
 *   - Each narado person gets a fixed numeric user and group, from NARADO_WORKER_UID_BASE
 *     (default 200000) upwards, kept in <data>/worker-uids.json. No /etc/passwd entries are
 *     needed: the ids exist only as numbers.
 *   - Their folder, <data>/users/<id>, is owned by that user and readable only by it (0700).
 *     Folders from before this mode are handed over the first time.
 *   - <data> and <data>/users can be passed through but not listed (0711); narado.json (the
 *     shared host settings workers read) is readable (0644); everything else in <data> stays
 *     the front's own.
 *   - The worker starts with that user and group and no supplementary groups (Node drops them
 *     when a uid or gid is given), and HOME and TMPDIR in its folder.
 *
 * The front needs to be allowed to do this: it runs as root with only CAP_SETUID, CAP_SETGID,
 * CAP_CHOWN, CAP_FOWNER, CAP_DAC_OVERRIDE and CAP_KILL (deploy/ADMIN.md, "One system user per
 * person"). It refuses to start in this mode anywhere else, rather than quietly running every
 * worker as one user.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE = 200000;
const MAX_PEOPLE = 100000;

class WorkerUsers {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {object} [o.env]
   * @param {object} [o.os]  { platform, getuid, chown, lchown } for tests
   */
  constructor({ dataDir, env = process.env, os = {}, log = console }) {
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'worker-uids.json');
    this.platform = os.platform || process.platform;
    this.getuid = os.getuid || (process.getuid ? () => process.getuid() : () => -1);
    this.lchown = os.lchown || fs.lchownSync;
    this.log = log;
    const base = env.NARADO_WORKER_UID_BASE === undefined ? DEFAULT_BASE : Number(env.NARADO_WORKER_UID_BASE);
    if (!Number.isInteger(base) || base < 1000 || base > 2 ** 31 - MAX_PEOPLE - 1) {
      throw new Error('NARADO_WORKER_UID_BASE must be a whole number from 1000, well clear of the system\'s own users');
    }
    this.base = base;
  }

  /** Why this computer can't run workers as their own users, or null. */
  cannot() {
    if (this.platform !== 'linux') return 'NARADO_WORKER_USERS=1 works on Linux only';
    if (this.getuid() !== 0) {
      return 'NARADO_WORKER_USERS=1 needs the front to run as root with CAP_SETUID, CAP_SETGID, CAP_CHOWN, CAP_FOWNER, CAP_DAC_OVERRIDE and CAP_KILL (see deploy/ADMIN.md)';
    }
    return null;
  }

  read() {
    try {
      const m = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return m && typeof m.people === 'object' ? m : { people: {} };
    } catch {
      return { people: {} };
    }
  }

  /** The person's numeric user (also their group), given once and kept. */
  idFor(userId) {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('Unexpected user id');
    const m = this.read();
    if (Number.isInteger(m.people[userId])) return m.people[userId];
    const taken = new Set(Object.values(m.people));
    let uid = this.base;
    while (taken.has(uid)) uid++;
    if (uid >= this.base + MAX_PEOPLE) throw new Error('No system users left for narado workers');
    m.people[userId] = uid;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return uid;
  }

  /** Give a folder (and everything in it) to uid, without following links. */
  handOver(dir, uid) {
    const walk = (p) => {
      const st = fs.lstatSync(p);
      if (st.uid !== uid || st.gid !== uid) this.lchown(p, uid, uid);
      if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    };
    walk(dir);
  }

  /**
   * Make <data>/users/<id> the person's own; returns { uid, gid } for the worker. Hands the
   * folder over when its top isn't theirs yet (first use, or a folder from before this mode).
   */
  prepare(userId, dir) {
    const uid = this.idFor(userId);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.chmodSync(this.dataDir, 0o711);
    fs.chmodSync(path.dirname(dir), 0o711);
    const shared = path.join(this.dataDir, 'narado.json');
    if (fs.existsSync(shared)) fs.chmodSync(shared, 0o644);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) throw new Error(`${dir} is a link; narado won't hand it to a worker`);
    if (st.uid !== uid || st.gid !== uid) {
      this.log.log(`[narado] giving ${path.relative(this.dataDir, dir)} to system user ${uid}`);
      this.handOver(dir, uid);
    }
    fs.chmodSync(dir, 0o700);
    return { uid, gid: uid };
  }
}

module.exports = { WorkerUsers, DEFAULT_BASE };
