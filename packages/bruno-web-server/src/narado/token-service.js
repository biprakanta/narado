/**
 * The front process's answers to token calls from workers (src/narado/workers.js),
 * limited to that worker's person. With sign-in off there is
 * one person and one worker, so nothing is filtered.
 */
const tokenService = (store, multiUser) => (user, method, args) => {
  const mine = (t) => !multiUser || (t && t.owner && user && t.owner.userId === user.id);
  switch (method) {
    case 'tokens.list':
      return store.list().filter(mine);
    case 'tokens.create': {
      const [opts = {}] = args;
      const owner = { ...(opts.owner || {}) };
      if (multiUser) Object.assign(owner, { userId: user.id }); // a worker cannot make tokens for someone else
      return store.create({ name: opts.name, scope: opts.scope, owner });
    }
    case 'tokens.revoke': {
      const t = store.list().find((x) => x.id === args[0]);
      if (!t || !mine(t)) throw new Error('No such token');
      store.revoke(t.id);
      return true;
    }
    case 'tokens.verify': {
      const record = store.verify(String(args[0] || ''));
      return record && mine(record) ? record : null;
    }
    case 'tokens.touch': {
      const t = store.list().find((x) => x.id === args[0]);
      if (t && mine(t)) store.touch(t.id);
      return true;
    }
    default:
      throw new Error(`Unknown call ${method}`);
  }
};

module.exports = { tokenService };
