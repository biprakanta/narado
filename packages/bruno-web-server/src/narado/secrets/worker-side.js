/**
 * Secret references in a worker (Phase 4e).
 *
 * Bruno's send handlers receive the environment, collection and request from the browser.
 * Just before one runs, every `secret://` reference in its arguments is resolved through the
 * front (which holds the store credentials and checks access) and replaced with its value.
 * The browser only ever holds references; what the worker sends back is cleaned by a Masker.
 *
 * Only these channels resolve references. Saving an environment, for example, never does,
 * so values cannot end up in files or in Git.
 */
const { findRefs, replaceRefs, Masker } = require('./refs');

const SEND_CHANNELS = [
  'send-http-request',
  'renderer:run-collection-folder',
  'fetch-gql-schema',
  'grpc:start-connection',
  'grpc:load-methods-reflection',
  'grpc:generate-grpcurl',
  'renderer:ws:start-connection',
  'renderer:ws:queue-message',
  'renderer:fetch-oauth2-credentials',
  'renderer:refresh-oauth2-credentials'
];

/** The collection in a handler's arguments: an object with a pathname and uid, at most one level down. */
const collectionPathIn = (args) => {
  const isCollection = (o) => o && typeof o === 'object' && typeof o.pathname === 'string' && typeof o.uid === 'string' && (o.items || o.brunoConfig || o.root);
  for (const a of args) {
    if (isCollection(a)) return a.pathname;
    if (a && typeof a === 'object' && isCollection(a.collection)) return a.collection.pathname;
  }
  return null;
};

class SecretRefs {
  /**
   * @param {object} o
   * @param {object} o.secrets    front calls: stores(), resolve(refs, ctx), list(store, prefix, ctx), check(ref, ctx)
   * @param {object} o.workspaces narado's WorkspaceManager, to tell which repo a collection is in
   */
  constructor({ secrets, workspaces, masker = new Masker() }) {
    this.secrets = secrets;
    this.workspaces = workspaces;
    this.masker = masker;
  }

  contextFor(collectionPath) {
    if (!collectionPath || !this.workspaces) return {};
    const loc = this.workspaces.locate(collectionPath);
    return loc ? { hostId: loc.hostId, repoPath: loc.repoPath } : {};
  }

  /** Arguments with references replaced by values; throws if any cannot be used. */
  async resolveArgs(args) {
    const refs = [...findRefs(args)];
    if (!refs.length) return args;
    const { values, errors } = await this.secrets.resolve(refs, this.contextFor(collectionPathIn(args)));
    const failed = Object.entries(errors || {});
    if (failed.length) {
      throw new Error(`Could not use ${failed.length === 1 ? 'a secret' : `${failed.length} secrets`}: ${failed.map(([ref, msg]) => `${ref}: ${msg}`).join('; ')}`);
    }
    for (const [ref, value] of Object.entries(values)) this.masker.add(value, ref);
    return replaceRefs(args, values);
  }

  /** Wrap Bruno's send handlers so they resolve references first. */
  install(ipcMain) {
    for (const ch of SEND_CHANNELS) {
      const original = ipcMain.getHandler(ch);
      if (!original) continue;
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (event, ...args) => original(event, ...(await this.resolveArgs(args))));
    }

    // For the interface's secrets picker. Values are never returned.
    ipcMain.handle('narado:secrets:stores', () => this.secrets.stores());
    ipcMain.handle('narado:secrets:list', (_e, store, prefix, collectionPath) => this.secrets.list(String(store || ''), String(prefix || ''), this.contextFor(collectionPath)));
    ipcMain.handle('narado:secrets:check', (_e, ref, collectionPath) => this.secrets.check(String(ref || ''), this.contextFor(collectionPath)));
  }

  /** Anything leaving the worker: secret values become references or masks. */
  clean(value) {
    return this.masker.clean(value);
  }
}

module.exports = { SecretRefs, SEND_CHANNELS, collectionPathIn };
