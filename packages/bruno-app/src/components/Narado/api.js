/**
 * Calls to narado's Git workspace handlers on the server (packages/bruno-web-server/src/narado/ipc.js).
 */
const invoke = (channel, payload) => window.ipcRenderer.invoke(channel, payload);

/** Turn "Error invoking remote method 'x': Error: message" into "message". */
export const errorText = (err) =>
  String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

export const isNaradoAvailable = () => typeof window !== 'undefined' && !!window.isBrunoWeb;

export const naradoApi = {
  hosts: () => invoke('narado:hosts'),
  repos: (hostId) => invoke('narado:repos', { hostId }),
  me: (hostId) => invoke('narado:me', { hostId }),
  open: (args) => invoke('narado:open', args),
  initCollection: (path, name) => invoke('narado:init-collection', { path, name }),
  workspaces: () => invoke('narado:workspaces'),
  reopen: (path) => invoke('narado:reopen', { path }),
  status: (path) => invoke('narado:status', { path }),
  commit: (path, message) => invoke('narado:commit', { path, message }),
  push: (path) => invoke('narado:push', { path }),
  createMergeRequest: (path, title, description) => invoke('narado:create-merge-request', { path, title, description }),
  updateFromDefault: (path) => invoke('narado:update-from-default', { path }),
  pullDefault: (path) => invoke('narado:pull-default', { path }),
  resolve: (path, file, side) => invoke('narado:resolve', { path, file, side }),
  abortMerge: (path) => invoke('narado:abort-merge', { path })
};
