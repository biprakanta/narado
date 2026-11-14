/**
 * narado as an MCP server (design §3b).
 *
 * AI assistants connect over MCP's Streamable HTTP transport at /mcp and can:
 *   - list workspaces, repos, requests and environments, and read requests and specs;
 *   - send a request, only to hosts the workspace itself names (its environments and the
 *     spec's servers, plus `.client/allowed-hosts.yml`), with scripts and tests switched off;
 *   - when the server runs with NARADO_MCP_ALLOW_WRITE=1, also edit requests and save
 *     changes (branch or fork, merge request), through the same code as the interface.
 *
 * Security: every request needs a personal token generated in narado (mcp-tokens.js). A
 * token acts as the person who made it: it is refused if narado's Git account is no longer
 * theirs, write tools are offered only to write tokens, and merge requests opened through
 * MCP name the person and the token. Browser Origins are refused and the Host header must
 * be the server's own address (DNS-rebinding protection). Secrets are masked in results.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { parseRequest, stringifyRequest, parseEnvironment } = require('@usebruno/filestore');
const { findSpec } = require('./openapi/spec');
const { TokenStore } = require('./mcp-tokens');

const MAX_BODY_CHARS = 100 * 1024;
const SECRET_NAME_RE = /(authorization|token|secret|password|passwd|api[-_]?key|cookie|session|private)/i;
const MASK = '••••••';

/* ------------------------------------------------------------------ helpers */

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Request files in a collection folder: .bru, and .yml requests in the newer format. */
const listRequestFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p);
      if (e.isDirectory()) {
        if (rel !== 'environments') walk(p);
      } else if (e.name.endsWith('.bru') && !['collection.bru', 'folder.bru'].includes(e.name)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
};

const readRequest = (root, rel) => {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(full)) {
    throw new Error(`No request "${rel}" in this workspace. Use list_requests to see what exists.`);
  }
  return { full, item: parseRequest(fs.readFileSync(full, 'utf8'), { format: 'bru' }) };
};

const readEnvironments = (root) => {
  const dir = path.join(root, 'environments');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.bru'))
    .map((f) => {
      const env = parseEnvironment(fs.readFileSync(path.join(dir, f), 'utf8'), { format: 'bru' });
      return { name: path.basename(f, '.bru'), variables: env.variables || [] };
    });
};

const maskValue = (name, value, secret) => (secret || SECRET_NAME_RE.test(name) ? (value ? MASK : value) : value);

const maskItem = (item) => {
  const req = item.request || {};
  const auth = req.auth && req.auth.mode && !['none', 'inherit'].includes(req.auth.mode) ? { mode: req.auth.mode, details: MASK } : req.auth;
  return {
    name: item.name,
    method: req.method,
    url: req.url,
    params: (req.params || []).map((p) => ({ name: p.name, type: p.type, value: maskValue(p.name, p.value), enabled: p.enabled !== false })),
    headers: (req.headers || []).map((h) => ({ name: h.name, value: maskValue(h.name, h.value), enabled: h.enabled !== false })),
    body: req.body,
    auth,
    docs: req.docs || '',
    hasScripts: !!(req.script && (req.script.req || req.script.res)),
    hasTests: !!req.tests
  };
};

/** Replace {{var}} using the given variables (one level, like Bruno's basic interpolation). */
const interpolate = (str, vars) => String(str || '').replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, name) => (name in vars ? String(vars[name]) : m));

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** Hosts a workspace names itself: environment values that are URLs, spec servers, allowed-hosts.yml. */
const allowedHostsFor = ({ repoPath, collectionRoot }) => {
  const hosts = new Set();
  for (const env of readEnvironments(collectionRoot)) {
    for (const v of env.variables) {
      const h = hostOf(v.value);
      if (h) hosts.add(h);
    }
  }
  const specFile = findSpec(repoPath);
  if (specFile) {
    try {
      const spec = YAML.parse(fs.readFileSync(specFile, 'utf8')) || {};
      for (const s of spec.servers || []) {
        const h = hostOf(s.url);
        if (h) hosts.add(h);
      }
    } catch {}
  }
  const allowFile = path.join(repoPath, '.client', 'allowed-hosts.yml');
  if (fs.existsSync(allowFile)) {
    try {
      const data = YAML.parse(fs.readFileSync(allowFile, 'utf8')) || {};
      for (const h of data.hosts || []) hosts.add(String(h).toLowerCase());
    } catch {}
  }
  return hosts;
};

/* ------------------------------------------------------------------ server */

/**
 * @param {object} deps
 * @param {Function} deps.call            invoke a narado:* or Bruno IPC handler: call(channel, ...args)
 * @param {object}   deps.workspaces      WorkspaceManager
 * @param {Function} deps.collectionsFor  (worktreePath) => [collection folders]
 */
const createMcpHandler = ({ call: baseCall, callAs, auth = null, ipcMain, workspaces, collectionsFor, dataDir, port, tokens: tokenStore, env = process.env, log = console }) => {
  const signInOn = !!(auth && auth.enabled);
  // The token store: the file in the data folder, or (in a per-user worker) the front
  // process's store, reached over IPC and limited to this worker's user.
  const tokens = tokenStore || new TokenStore({ dataDir });
  // Server-wide ceiling: NARADO_MCP_ALLOW_WRITE=0 turns write tools off for every token.
  const serverAllowsWrite = env.NARADO_MCP_ALLOW_WRITE !== '0';
  const url = `http://127.0.0.1:${port}/mcp`;

  /** The person narado currently acts for: their account on each connected Git host. */
  const currentOwner = async () => {
    const hosts = {};
    let name = null;
    for (const h of (await baseCall('narado:hosts')).filter((x) => x.connected)) {
      try {
        const me = await baseCall('narado:me', { hostId: h.id });
        hosts[h.id] = me.login;
        name = name || me.name;
      } catch (err) {
        log.warn(`[narado] could not read the account on ${h.id}: ${err.message}`);
      }
    }
    return { name: name || Object.values(hosts)[0] || null, hosts };
  };

  /** A token's owner must still be who narado acts for on at least one host, and on every host both know. */
  const ownerMismatch = (owner, current) => {
    const shared = Object.keys(owner.hosts || {}).filter((h) => current.hosts[h]);
    if (!shared.length) return 'none of the Git accounts this token was made with are connected any more';
    for (const h of shared) {
      if (String(owner.hosts[h]).toLowerCase() !== String(current.hosts[h]).toLowerCase()) {
        return `this token belongs to ${owner.hosts[h]} on ${h}, but narado is now connected as ${current.hosts[h]}`;
      }
    }
    return null;
  };

  // Token management for the interface (the person signed in to narado manages their own tokens).
  if (ipcMain) {
    ipcMain.handle('narado:mcp-info', async () => ({ url, writeAllowed: serverAllowsWrite }));
    // With sign-in on, people see, create and revoke only their own tokens.
    const signedIn = (e) => {
      const user = e && e.narado && e.narado.user;
      if (signInOn && !user) throw new Error('Sign in to manage MCP tokens');
      return user;
    };
    const mine = (e) => {
      const user = signedIn(e);
      return (t) => !signInOn || (t.owner && t.owner.userId === user.id);
    };
    ipcMain.handle('narado:mcp-tokens', async (e) => (await tokens.list()).filter(mine(e)));
    ipcMain.handle('narado:mcp-tokens:create', async (e, { name, scope }) => {
      const user = signedIn(e);
      if (scope === 'write' && !serverAllowsWrite) throw new Error('Write tokens are turned off on this server (NARADO_MCP_ALLOW_WRITE=0)');
      const owner = await currentOwner();
      if (user) Object.assign(owner, { userId: user.id, name: user.name || owner.name, email: user.email || null });
      return await tokens.create({ name, scope, owner });
    });
    ipcMain.handle('narado:mcp-tokens:revoke', async (e, { id }) => {
      const t = (await tokens.list()).find((x) => x.id === id);
      if (!t || !mine(e)(t)) throw new Error('No such token');
      await tokens.revoke(id);
      return true;
    });
  }
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  /** Resolve a workspace id (its path, as list_workspaces returns it) to its collection folder. */
  const resolveWorkspace = async (id) => {
    const loc = workspaces.locate(String(id || ''));
    if (!loc) throw new Error(`Unknown workspace "${id}". Use list_workspaces, or open_repo to open one.`);
    const collections = await collectionsFor(loc.path);
    if (!collections.length) throw new Error('This workspace has no collection yet');
    return { ...loc, collectionRoot: collections[0] };
  };

  const buildServer = (record, user) => {
    // Every call an assistant makes runs as the token's owner.
    const call = callAs ? callAs(user) : baseCall;
    const allowWrite = serverAllowsWrite && record.scope === 'write';
    const madeBy = `Opened from narado by ${record.owner.name || 'its owner'} through the MCP token "${record.name}".`;
    const server = new McpServer(
      { name: 'narado', version: '0.1.0' },
      {
        instructions:
          'narado holds API collections stored in Git (OpenAPI specs plus client data). Start with list_workspaces; '
          + 'open_repo opens a repo if needed. Requests are identified by their file path from list_requests. '
          + 'send_request only reaches hosts the workspace itself names, and runs without scripts or tests. '
          + (allowWrite ? 'Edits (update_request) stay local until save_changes commits, pushes and opens a merge request.' : 'This token is read-only.')
      }
    );

    const tool = (name, description, schema, handler, annotations = {}) =>
      server.registerTool(name, { description, inputSchema: schema, annotations }, async (args) => {
        try {
          return await handler(args || {});
        } catch (err) {
          return fail(String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
        }
      });

    tool('list_hosts', 'Git hosts narado is configured for, and whether each is connected.', {}, async () => text(await call('narado:hosts')), { readOnlyHint: true });

    tool(
      'list_repos',
      'Repositories on a Git host that the connected account can access, with access level (read, write, admin).',
      { host: z.string().describe('Host id from list_hosts, for example "github"'), filter: z.string().optional().describe('Only repos whose path contains this text') },
      async ({ host, filter }) => {
        const repos = await call('narado:repos', { hostId: host });
        const f = (filter || '').toLowerCase();
        return text(repos.filter((r) => !f || r.path.toLowerCase().includes(f)).slice(0, 200).map((r) => ({ path: r.path, access: r.access, defaultBranch: r.defaultBranch, private: r.private })));
      },
      { readOnlyHint: true }
    );

    tool(
      'open_repo',
      'Open a repository in narado on its default branch (cloned on the server if needed). Returns the workspace id.',
      { host: z.string(), repo: z.string().describe('owner/name') },
      async ({ host, repo }) => {
        const ws = await call('narado:open', { hostId: host, repoPath: repo });
        return text({ workspace: ws.path, repo, branch: ws.branch, openapi: !!findSpec(ws.path) });
      },
      { readOnlyHint: true, openWorldHint: true }
    );

    tool('list_workspaces', 'Repositories and branches open in narado. The workspace value identifies one in other tools.', {}, async () => {
      const list = await call('narado:workspaces');
      return text(list.map((w) => ({ workspace: w.path, host: w.hostId, repo: w.repoPath, branch: w.branch, openapi: !!findSpec(w.path) })));
    }, { readOnlyHint: true });

    tool(
      'list_requests',
      'Requests in a workspace, with the id (file path) used by get_request and send_request.',
      { workspace: z.string() },
      async ({ workspace }) => {
        const ws = await resolveWorkspace(workspace);
        return text(
          listRequestFiles(ws.collectionRoot).map((rel) => {
            const { item } = readRequest(ws.collectionRoot, rel);
            return { request: rel, name: item.name, method: item.request.method, url: item.request.url, folder: path.dirname(rel) === '.' ? null : path.dirname(rel) };
          })
        );
      },
      { readOnlyHint: true }
    );

    tool(
      'get_request',
      'One request in full (secrets masked). For OpenAPI repos, also the operation from the spec.',
      { workspace: z.string(), request: z.string().describe('Request id from list_requests') },
      async ({ workspace, request }) => {
        const ws = await resolveWorkspace(workspace);
        const { item } = readRequest(ws.collectionRoot, request);
        const result = { request, ...maskItem(item) };
        const specFile = findSpec(ws.path);
        if (specFile) {
          const spec = YAML.parse(fs.readFileSync(specFile, 'utf8')) || {};
          const opId = path.basename(request, '.bru');
          for (const [p, pathItem] of Object.entries(spec.paths || {})) {
            for (const [m, op] of Object.entries(pathItem || {})) {
              if (op && op.operationId === opId) result.operation = { path: p, method: m, ...op };
            }
          }
        }
        return text(result);
      },
      { readOnlyHint: true }
    );

    tool(
      'get_spec',
      'The OpenAPI spec of a workspace, as stored in the repo.',
      { workspace: z.string() },
      async ({ workspace }) => {
        const loc = workspaces.locate(String(workspace));
        if (!loc) throw new Error(`Unknown workspace "${workspace}"`);
        const specFile = findSpec(loc.path);
        if (!specFile) throw new Error('This workspace has no OpenAPI spec');
        return text(fs.readFileSync(specFile, 'utf8'));
      },
      { readOnlyHint: true }
    );

    tool(
      'list_environments',
      'Environments of a workspace and their variables (secrets masked).',
      { workspace: z.string() },
      async ({ workspace }) => {
        const ws = await resolveWorkspace(workspace);
        return text(readEnvironments(ws.collectionRoot).map((e) => ({ name: e.name, variables: e.variables.map((v) => ({ name: v.name, value: maskValue(v.name, v.value, v.secret) })) })));
      },
      { readOnlyHint: true }
    );

    tool(
      'send_request',
      'Send a request and return the response. Only hosts named by the workspace (environments, spec servers, .client/allowed-hosts.yml) are allowed. '
      + 'Pre- and post-request scripts and tests do not run for requests sent this way.',
      {
        workspace: z.string(),
        request: z.string(),
        environment: z.string().optional().describe('Environment name from list_environments; defaults to the first'),
        params: z.record(z.string(), z.string()).optional().describe('Query or path parameter values to use for this send only'),
        headers: z.record(z.string(), z.string()).optional().describe('Header values to use for this send only'),
        body: z.string().optional().describe('Body text to use for this send only (JSON as a string)')
      },
      async ({ workspace, request, environment, params, headers, body }) => {
        const ws = await resolveWorkspace(workspace);
        const { full, item } = readRequest(ws.collectionRoot, request);
        const envs = readEnvironments(ws.collectionRoot);
        const env = environment ? envs.find((e) => e.name === environment) : envs[0];
        if (environment && !env) throw new Error(`No environment "${environment}". Available: ${envs.map((e) => e.name).join(', ') || 'none'}`);
        const vars = Object.fromEntries(((env && env.variables) || []).filter((v) => v.enabled !== false).map((v) => [v.name, v.value]));

        const req = JSON.parse(JSON.stringify(item.request));
        for (const [k, v] of Object.entries(params || {})) {
          const p = (req.params || []).find((x) => x.name === k);
          if (p) {
            p.value = v;
            p.enabled = true;
          } else {
            req.params = [...(req.params || []), { name: k, value: v, enabled: true, type: 'query' }];
          }
        }
        for (const [k, v] of Object.entries(headers || {})) {
          const h = (req.headers || []).find((x) => x.name.toLowerCase() === k.toLowerCase());
          if (h) {
            h.value = v;
            h.enabled = true;
          } else {
            req.headers = [...(req.headers || []), { name: k, value: v, enabled: true }];
          }
        }
        if (body !== undefined) req.body = { mode: req.body && req.body.mode !== 'none' ? req.body.mode : 'json', json: body, text: body };
        // Rebuild the query string from params, as Bruno's interface does.
        const base = String(req.url).split('?')[0];
        const query = (req.params || []).filter((p) => p.type === 'query' && p.enabled !== false).map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`)).join('&');
        req.url = query ? `${base}?${query}` : base;

        // Host check on the URL as it will be sent.
        const target = hostOf(interpolate(req.url, vars).replace(/:([A-Za-z0-9_]+)/g, 'x'));
        const allowed = allowedHostsFor({ repoPath: ws.path, collectionRoot: ws.collectionRoot });
        if (!target) throw new Error(`The URL does not resolve to a full address: ${req.url}. Pick an environment that defines its variables.`);
        if (!allowed.has(target)) {
          throw new Error(`${target} is not a host this workspace names. Allowed: ${[...allowed].join(', ') || 'none'}. Add it to an environment or to .client/allowed-hosts.yml.`);
        }

        // Scripts and tests can change the URL or make their own calls, so they are off here.
        req.script = {};
        req.tests = '';
        const sendItem = { ...item, uid: crypto.randomUUID(), pathname: full, request: req };
        const collection = {
          uid: crypto.createHash('sha1').update(ws.collectionRoot).digest('hex').slice(0, 21),
          name: path.basename(ws.collectionRoot),
          pathname: ws.collectionRoot,
          root: { request: {} },
          brunoConfig: { version: '1', name: path.basename(ws.collectionRoot), type: 'collection' },
          globalEnvironmentVariables: {},
          runtimeVariables: {},
          items: [sendItem]
        };
        const envForBruno = env ? { name: env.name, variables: env.variables.map((v) => ({ ...v, uid: crypto.randomUUID(), enabled: v.enabled !== false })) } : null;
        const res = await call('send-http-request', sendItem, collection, envForBruno, {});

        if (res && res.error && !res.status) throw new Error(`Request failed: ${res.error}`);
        let data = res.data;
        if (typeof data !== 'string') data = JSON.stringify(data, null, 2);
        const truncated = data && data.length > MAX_BODY_CHARS;
        return text({
          status: res.status,
          statusText: res.statusText,
          durationMs: res.duration,
          headers: Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k, maskValue(k, v)])),
          body: truncated ? data.slice(0, MAX_BODY_CHARS) : data,
          ...(truncated ? { note: `Body truncated to ${MAX_BODY_CHARS} characters` } : {}),
          scriptsRun: false
        });
      },
      { readOnlyHint: false, openWorldHint: true }
    );

    tool('workspace_status', 'Git status of a workspace: branch, changed files, merge request.', { workspace: z.string() }, async ({ workspace }) => {
      const st = await call('narado:status', { path: String(workspace) });
      return text({
        repo: st.repoPath,
        branch: st.branch,
        onDefaultBranch: st.onDefaultBranch,
        changes: st.files.map((f) => ({ path: f.path, status: f.status })),
        aheadOfDefault: st.aheadOfDefault,
        behindDefault: st.behindDefault,
        mergeRequest: st.mergeRequest,
        canSaveVia: st.saveVia
      });
    }, { readOnlyHint: true });

    if (allowWrite) {
      tool(
        'update_request',
        'Edit a request. Edits stay local in the workspace until save_changes. In OpenAPI repos they update the spec and .client files.',
        {
          workspace: z.string(),
          request: z.string(),
          name: z.string().optional(),
          method: z.string().optional(),
          url: z.string().optional().describe('Full Bruno URL, for example {{baseUrl}}/payments/:id?limit=10'),
          docs: z.string().optional(),
          body: z.string().optional().describe('JSON body text'),
          params: z.array(z.object({ name: z.string(), value: z.string(), type: z.enum(['query', 'path']), enabled: z.boolean().optional() })).optional().describe('Replaces all parameters'),
          headers: z.array(z.object({ name: z.string(), value: z.string(), enabled: z.boolean().optional() })).optional().describe('Replaces all headers')
        },
        async ({ workspace, request, name, method, url, docs, body, params, headers }) => {
          const ws = await resolveWorkspace(workspace);
          const { full, item } = readRequest(ws.collectionRoot, request);
          if (name !== undefined) item.name = name;
          if (method !== undefined) item.request.method = method.toUpperCase();
          if (docs !== undefined) item.request.docs = docs;
          if (body !== undefined) item.request.body = { mode: 'json', json: body };
          if (params !== undefined) item.request.params = params.map((p) => ({ ...p, enabled: p.enabled !== false }));
          if (headers !== undefined) item.request.headers = headers.map((h) => ({ ...h, enabled: h.enabled !== false }));
          if (url !== undefined) item.request.url = url;
          else if (params !== undefined) {
            const base = String(item.request.url).split('?')[0];
            const q = item.request.params.filter((p) => p.type === 'query' && p.enabled).map((p) => (p.value === '' ? p.name : `${p.name}=${p.value}`)).join('&');
            item.request.url = q ? `${base}?${q}` : base;
          }
          fs.writeFileSync(full, stringifyRequest(item, { format: 'bru' }));
          // Let the OpenAPI sync engine (if any) write the change into the repo.
          await call('narado:status', { path: ws.path });
          return text({ updated: request, ...maskItem(item) });
        },
        { readOnlyHint: false, destructiveHint: false }
      );

      tool(
        'save_changes',
        'Save the workspace\'s edits: on the default branch, as a new branch in the repo or the person\'s fork; on a change branch, as a commit. '
        + 'Pushes, and opens a merge request into the default branch unless told not to.',
        {
          workspace: z.string(),
          message: z.string().describe('Commit message'),
          change_name: z.string().optional().describe('Short name for the new branch (needed on the default branch)'),
          via: z.enum(['branch', 'fork']).optional().describe('Where a change from the default branch goes; defaults to branch when allowed'),
          open_merge_request: z.boolean().optional()
        },
        async ({ workspace, message, change_name: topic, via, open_merge_request: openMr = true }) => {
          const st = await call('narado:status', { path: String(workspace) });
          if (st.onDefaultBranch) {
            if (!topic) throw new Error('change_name is needed to save changes made on the default branch');
            const res = await call('narado:save-as-change', { path: st.path, topic, via: via || st.saveVia[0], message, openMergeRequest: openMr, description: madeBy });
            return text({ branch: res.branch, via: res.via, workspace: res.path, commit: res.sha, pushed: !res.pushError, pushError: res.pushError, mergeRequest: res.mergeRequest, mergeRequestError: res.mergeRequestError });
          }
          const commit = await call('narado:commit', { path: st.path, message });
          const mergeRequest = openMr ? await call('narado:create-merge-request', { path: st.path, title: message, description: madeBy }) : (await call('narado:push', { path: st.path }), null);
          return text({ branch: st.branch, commit: commit.sha, mergeRequest });
        },
        { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
      );
    }

    return server;
  };

  /** Handle a request to /mcp. Returns false for other paths. */
  const handle = async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname !== '/mcp') return false;

    const deny = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
      return true;
    };
    // Browsers send an Origin; MCP clients do not. Refuse pages trying to reach narado.
    if (req.headers.origin) return deny(403, 'Browser origins may not use the MCP endpoint');
    const authorization = String(req.headers.authorization || '');
    const record = authorization.startsWith('Bearer ') ? await tokens.verify(authorization.slice(7).trim()) : null;
    if (!record) {
      res.setHeader('www-authenticate', 'Bearer');
      return deny(401, 'A valid narado MCP token is required. Create one in narado: Git section, MCP tokens.');
    }
    let user = null;
    if (signInOn) {
      user = record.owner.userId ? auth.users.getUser(record.owner.userId) : null;
      if (!user) {
        res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        return deny(401, `Token "${record.name}" does not belong to a narado user. Create a new one after signing in.`);
      }
    }
    const mismatch = ownerMismatch(record.owner, await currentOwner());
    if (mismatch) {
      res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
      return deny(401, `Token "${record.name}" cannot be used: ${mismatch}.`);
    }
    await tokens.touch(record.id);

    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        return deny(400, 'Invalid JSON');
      }
    }

    // Stateless: a fresh server and transport per request.
    const server = buildServer(record, user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error('[narado] MCP request failed:', err);
      if (!res.headersSent) deny(500, 'Internal error');
    }
    return true;
  };

  return { handle, url, writeAllowed: serverAllowsWrite };
};

module.exports = { createMcpHandler, allowedHostsFor, maskItem, interpolate };
