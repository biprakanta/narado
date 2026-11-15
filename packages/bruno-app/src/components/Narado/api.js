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
  catalogue: (hostId, refresh = false) => invoke('narado:catalogue', { hostId, refresh }),
  repo: (hostId, repoPath) => invoke('narado:repo', { hostId, repoPath }),
  open: (args) => invoke('narado:open', args),
  initCollection: (path, name) => invoke('narado:init-collection', { path, name }),
  workspaces: () => invoke('narado:workspaces'),
  reopen: (path) => invoke('narado:reopen', { path }),
  status: (path) => invoke('narado:status', { path }),
  commit: (path, message) => invoke('narado:commit', { path, message }),
  saveAsChange: (args) => invoke('narado:save-as-change', args),
  push: (path) => invoke('narado:push', { path }),
  createMergeRequest: (path, title, description) => invoke('narado:create-merge-request', { path, title, description }),
  updateFromDefault: (path) => invoke('narado:update-from-default', { path }),
  pullDefault: (path) => invoke('narado:pull-default', { path }),
  resolve: (path, file, side) => invoke('narado:resolve', { path, file, side }),
  abortMerge: (path) => invoke('narado:abort-merge', { path }),
  requestRules: (path) => invoke('narado:request-rules', { path }),
  mcpInfo: () => invoke('narado:mcp-info'),
  mcpTokens: () => invoke('narado:mcp-tokens'),
  createMcpToken: (name, scope) => invoke('narado:mcp-tokens:create', { name, scope }),
  revokeMcpToken: (id) => invoke('narado:mcp-tokens:revoke', { id })
};

/** Start connecting a Git account: the host asks the person, then sends them back here. */
export const connectGitAccount = (host) => {
  const back = window.location.pathname + window.location.search;
  window.location.assign(`${host.connectUrl}?return=${encodeURIComponent(back)}`);
};

/** Disconnect a Git account (also withdraws narado's access on the host). */
export const disconnectGitAccount = async (hostId) => {
  const res = await fetch(`/auth/git/${encodeURIComponent(hostId)}/disconnect`, { method: 'POST', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Could not disconnect (${res.status})`);
};

/** Sign out of narado (and the identity provider, when it supports it). */
export const signOut = async () => {
  const res = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  window.location.assign(data.redirect || '/');
};
