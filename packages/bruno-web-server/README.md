# bruno-web-server

The server half of narado. It runs Bruno in a browser, one Bruno process per person.

- **The front** (`src/server.js`) handles sign-in, serves the interface, checks origins, sessions and MCP tokens, and relays each person's traffic to their own worker. It does not load Bruno.
- **Workers** (`src/worker.js`, managed by `src/narado/workers.js`) each run Bruno's main-process code (`packages/bruno-electron/src`) in plain Node.js, with the `electron` module replaced by `src/electron-stub.js`. They relay IPC between the browser and Bruno's handlers over a WebSocket at `/ipc`, and serve MCP at `/mcp`.
- **In the browser,** `packages/bruno-app/src/web-bridge.js` provides `window.ipcRenderer` when Electron is not present.

What each phase added:

- **Phase 1:** Bruno in the browser, collections in folders on the server's disk.
- **Phase 2:** Git-backed workspaces on GitHub and GitLab (`src/narado/`, and the **Git** section in the sidebar from `packages/bruno-app/src/components/Narado/`).
- **Phase 3:** OpenAPI storage and the MCP server.
- **Phase 4b:** sign-in with OpenID Connect.
- **Phase 4d:** a separate, sandboxed Bruno process for each person.
- **Phase 4e:** secrets from HashiCorp Vault, AWS Secrets Manager, Google Secret Manager and Azure Key Vault.

## Run

From the repo root, after `npm run setup`:

```bash
NARADO_GITHUB_TOKEN=<token> node packages/bruno-web-server/src/server.js
```

```bash
npm run dev:web
```

Open http://localhost:3000. The rsbuild dev server forwards `/ipc` to the server on port 4100.

To serve a production build from the server itself instead, run `npm run build:web` and open http://localhost:4100.

## Git hosts

Without a config file, GitHub.com and GitLab.com are available. Each host's token comes from an environment variable on the server, `NARADO_<HOST ID>_TOKEN`, never from a file:

| Host | Variable | Token needs |
|---|---|---|
| GitHub.com (`github`) | `NARADO_GITHUB_TOKEN` | `repo` scope (classic), or Contents and Pull requests read/write (fine-grained) |
| GitLab.com (`gitlab`) | `NARADO_GITLAB_TOKEN` | `api` scope |

For self-managed GitLab, or to change the list, create `<data dir>/narado.json`:

```json
{
  "hosts": [
    { "id": "github", "type": "github" },
    { "id": "acme-gitlab", "type": "gitlab", "url": "https://gitlab.acme.internal" }
  ]
}
```

The second host above reads `NARADO_ACME_GITLAB_TOKEN`; set `"tokenEnv"` on a host to use another name. A host without a token shows as not connected.

These server-wide tokens stand in for per-person sign-in, which comes in Phase 4 (GitHub App and GitLab OAuth, linked to company SSO).

### How workspaces work

- **One bare clone per repo**, under `<data dir>/git/<host>/<owner>/<repo>.git`, plus **one Git worktree per branch** under `<data dir>/git/<host>/<owner>/<repo>/worktrees/`.
- **Start a change** creates `narado/<login>/<topic>` from the default branch. **Browse** opens the default branch read-only. Commits to the default branch are refused, since changes go through merge requests.
- **Commit** stages everything in the working copy. **Push and open** pushes and opens a pull request (GitHub) or merge request (GitLab) into the default branch.
- **Update from main** merges the default branch in. Conflicts are listed per file with **Keep mine** or **Keep main**, and the update can be cancelled.
- **Tokens:** the token reaches Git as an HTTP header through `GIT_CONFIG_*` environment variables, per command. It is never written to remote URLs, Git config or disk. Credential helpers are switched off for these commands.
- **Timeouts:** network commands time out after 2 minutes, and stalled transfers abort after 30 seconds.

## Sign-in

narado signs people in with any OpenID Connect provider (Keycloak, Okta, Google Workspace, Microsoft Entra ID and others). Register narado with the provider as a confidential web application with the redirect URI `<public URL>/auth/callback`, then set:

| Variable | Meaning |
|---|---|
| `NARADO_OIDC_ISSUER` | The provider's issuer URL, for example `https://login.acme.com/realms/acme` |
| `NARADO_OIDC_CLIENT_ID`, `NARADO_OIDC_CLIENT_SECRET` | narado's client credentials at the provider |
| `NARADO_PUBLIC_URL` | The address people open narado at, for example `https://narado.acme.com` |
| `NARADO_ALLOWED_EMAIL_DOMAINS` | Optional: only these email domains may sign in, comma-separated |
| `NARADO_OIDC_SCOPES` | Optional: default `openid profile email` |
| `NARADO_OIDC_PROVIDER_NAME` | Optional: the name on the sign-in button, for example `Okta`. Default "single sign-on" |
| `NARADO_OIDC_AUTO_REDIRECT` | Optional: `1` skips narado's sign-in page and goes straight to the provider |

People first see narado's own sign-in page (`src/narado/pages.js`). Sign-out and sign-in errors come back to it.

- **The flow:** authorization code with PKCE. ID tokens are checked for signature, issuer, audience, expiry and nonce.
- **Sessions:** kept in `<data dir>/narado.db`, with only hashes of the session ids stored. A session ends after 12 hours idle or 7 days in total. The cookie is HttpOnly and SameSite=Lax, and also Secure on https.
- **What sign-in protects:** the app, the IPC WebSocket and token management. MCP tokens belong to the person who created them.
- **Without sign-in,** narado is a single-user local tool and refuses to listen on anything but a loopback address.

For local development, `dev/keycloak/` has a realm with two test users and the exact commands.

## One Bruno process per person

With sign-in on, each person gets their own worker the first time they connect, with their own data folder at `<data dir>/users/<user id>`: open collections, preferences, Git clones and Bruno's encrypted secrets. Without sign-in there is one worker, using the data folder itself, as before.

- **Relaying.** A worker listens on a random loopback port and accepts only requests carrying a secret the front gave it. The front passes on that person's WebSocket and MCP requests without their cookies.
- **Sandbox.** Workers run under Node's permission model. A worker may read narado's code, its own folder and the shared `narado.json`, and write only its own folder. Another person's files, and the sign-in database, are refused.
- **Scripts** only run in Bruno's Safe Mode (QuickJS); Developer Mode is refused, because Node's `vm` can be escaped.
- **Turned off in a worker:** installing npm packages (install scripts run code) and Bruno's own Git clone and branch listing (any path, any URL). narado's Git section replaces the latter.
- **Secrets stay in the front.** Sign-in settings (`NARADO_OIDC_*`) and secrets-store credentials (`NARADO_SECRETS_*`) are not passed to workers. MCP tokens are stored only by the front; a worker can list, create, revoke and check only its own person's tokens.
- **Lifecycle.** Idle workers stop after 30 minutes without a connection. A crashed or stopped worker starts again on the next request, and open pages reload to match it.
- **Size.** About 60 to 170 MB of memory per active person.

## Secrets

Secrets stay in the organisation's secrets store. An environment variable holds a **reference**, which is committed to Git like any other value:

```
secret://<store>/<path>[#<field>]       for example  secret://vault/payments/staging#api_key
```

- **When a request is sent,** the person's worker asks the front for the values of the references in it. The front checks access, reads the store and answers. The worker swaps the references for values, only for sending: saving an environment never resolves anything.
- **Values never reach the browser.** In everything a worker sends back (responses, timelines, script output, MCP results), a string that is exactly a secret's value turns back into its reference, and any other occurrence is masked as `••••••`, also when URL- or base64-encoded.
- **Store credentials never reach a worker.** They are read by the front from `NARADO_SECRETS_<STORE ID>_*` variables, which workers do not get.
- **Every read is logged** by the front with the person, store, path, repo and outcome, never the value. Values are cached for 60 seconds (`NARADO_SECRETS_CACHE_SECONDS`); access is checked every time.
- **Picker:** the lock button in the Git section browses the stores (only what you may use), builds a reference and checks it without showing the value.

Configure stores in `<data dir>/narado.json`:

```json
{
  "secrets": {
    "stores": [
      { "id": "vault", "type": "vault", "url": "https://vault.acme.internal", "auth": { "method": "jwt", "role": "narado" } },
      { "id": "aws", "type": "aws", "region": "ap-south-1" },
      { "id": "gcp", "type": "gcp", "project": "acme-payments" },
      { "id": "azure", "type": "azure", "vaultUrl": "https://acme-payments.vault.azure.net", "tenant": "<tenant id>" }
    ],
    "access": [
      { "store": "aws", "paths": ["payments/staging/*"], "repos": ["github:acme/payments-api"], "people": ["*@acme.com"] }
    ]
  }
}
```

| Type | Path in a reference | Credentials (`<ID>` is the store id in capitals) |
|---|---|---|
| `vault` (KV v2; `mount`, default `secret`; optional `namespace`) | the KV path; `#field` picks a key | `auth.method` `jwt`: none, see below. `approle`: `NARADO_SECRETS_<ID>_ROLE_ID`, `_SECRET_ID`. `token`: `NARADO_SECRETS_<ID>_TOKEN` |
| `aws` (Secrets Manager) | the secret's name; `#field` reads a JSON secret | `NARADO_SECRETS_<ID>_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_SESSION_TOKEN` |
| `gcp` (Secret Manager) | the secret's name, optional `@version` | `NARADO_SECRETS_<ID>_CREDENTIALS`: a service account key (JSON) |
| `azure` (Key Vault) | the secret's name, optional `@version` | `NARADO_SECRETS_<ID>_CLIENT_ID`, `_CLIENT_SECRET` (an app registration) |

Each store also takes an `endpoint` (or `authority`, `tokenUrl`) to point at a private endpoint or an emulator.

**Who may read what.**

- **Per person:** a Vault store with `"auth": { "method": "jwt", "role": "…" }` signs in as the person. narado signs a two-minute token naming them (`sub`, `email`, `name`, audience `vault`) with its own key, kept in `<data dir>/narado-identity-key.pem`. Vault's JWT auth method checks it against `<public URL>/auth/jwks.json`, so Vault's own policies decide. Set up Vault with `jwks_url` pointing there, `bound_issuer` set to narado's public URL, and a role with `user_claim=email` and `bound_audiences=vault`.
- **Service identity** (every other store and sign-in method): narado gives out only what an `access` rule allows. A rule matches when everything it names holds: `store`, `paths` (`*` matches anything), `repos` (`<host id>:<owner>/<repo>` of the workspace the request is in) and `people` (emails or user ids, `*` allowed). With no matching rule, nothing is given out. Collections outside a Git workspace only match rules without `repos`.
- Rules naming a per-person store narrow it further.

`dev/vault/` sets up a local Vault with both kinds of store.

## MCP server

AI assistants can use narado through MCP (Streamable HTTP) at `http://127.0.0.1:4100/mcp`.

**Tokens.** Each person creates their own tokens in narado: Git section, key button, **MCP tokens**. A token acts as the person who made it:

- It records their account on each connected Git host when it is created. If narado is later connected to a different account, the token is refused.
- **Read** tokens can list hosts, repos, workspaces, requests and environments, read requests and OpenAPI specs, and send requests.
- **Read and write** tokens can also edit requests (`update_request`) and save changes (`save_changes`: a new branch or fork plus a merge request, or a commit on a change branch). Merge requests opened this way name the person and the token.
- The token is shown once; only its SHA-256 hash is stored, in `<data dir>/mcp-tokens.json`. Tokens can be revoked from the same dialog.
- `NARADO_MCP_ALLOW_WRITE=0` turns write tools off for every token.

**Sending requests.** `send_request` only reaches hosts the workspace names itself: URLs in its environments, the spec's `servers`, and `.client/allowed-hosts.yml` (`hosts: [...]`). Pre- and post-request scripts and tests do not run for MCP sends, because they could change the target or make their own calls. Secrets are masked in tool results.

**Other protections.** Requests with a browser `Origin` are refused, and the `Host` header must be the server's own address.

To add narado to Claude Code (the dialog shows this command with your token filled in):

```bash
claude mcp add --transport http narado http://127.0.0.1:4100/mcp --header "Authorization: Bearer <token>"
```

`scripts/mcp-smoke.js` exercises the endpoint with the MCP SDK's client.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BRUNO_WEB_PORT` | `4100` | Server port |
| `BRUNO_WEB_HOST` | `127.0.0.1` | Address to listen on |
| `BRUNO_WEB_ORIGINS` | `http://localhost:3000`, `http://127.0.0.1:3000` and the server's own origin | Browser origins allowed to connect, comma-separated |
| `BRUNO_WEB_DATA_DIR` | `~/.bruno-web` | Sign-in database, MCP tokens, `narado.json`; with sign-in, each person's folder under `users/` |
| `BRUNO_WEB_SERVER` | `http://127.0.0.1:4100` | Where the rsbuild dev server forwards `/ipc` |
| `NARADO_<HOST ID>_TOKEN` | none | Token for a Git host (see above) |
| `NARADO_MCP_ALLOW_WRITE` | on | `0` turns MCP write tools off for every token |
| `NARADO_WORKER_IDLE_MINUTES` | `30` | Stop a person's worker after this long without a connection |
| `NARADO_MAX_WORKERS` | `50` | Most workers at once; when full, the longest-idle one makes room, or new people get 503 |
| `NARADO_WORKER_SANDBOX` | on with sign-in | `0` runs workers without Node's permission model. Only for debugging |
| `NARADO_SECRETS_<STORE ID>_*` | none | Secrets store credentials (see Secrets) |
| `NARADO_SECRETS_CACHE_SECONDS` | `60` | How long the front keeps a secret's value |

## Tests

```bash
npm test --workspace=packages/bruno-web-server
```

The workspace tests run real Git against a local repo standing in for the host, including merge conflicts. The provider tests use a fake HTTP layer.

## Known limits

- **Git access is still the server's.** Until Phase 4c, every person's worker uses the server-wide host tokens, so everyone acts as the same Git account. Per-person Git accounts come with the GitHub App and GitLab OAuth.
- **The sandbox has gaps.**
  - Workers run as the same operating-system account as the front.
  - Child processes (git, and the shell Bruno reads its environment from) are not covered by Node's permission model; narado builds their arguments itself.
  - Native add-ons are allowed, for file watching.
  - Network access is open until Phase 4a adds rules for where requests may go.
  - For a hosted service, run each worker in its own container or OS user as well.
- **Data from before Phase 4d** at the top of the data folder is not moved into anyone's `users/` folder; people re-open their repositories.
- **fsync** is skipped inside sandboxed workers, because Node's permission model refuses it, so a power cut can lose the last settings write.

- **Folder and file pickers** are a browser prompt asking for a path on the server.
- **Drag-and-drop file paths** are not available, because browsers don't expose them.
- **Turned off:** the built-in terminal (it would give a shell on the server), window controls and native menus.
- **Bruno's own secret variables** (the "secret" checkbox) still work, encrypted with a key file in each person's folder. Prefer `secret://` references, which keep values in the organisation's store.
- **Secret references and the repo.** Until Phase 4c, the front trusts the worker about which repo a request is in when applying `repos` rules; with per-person Git accounts it can check the person can read that repo.
- **Scripts can read resolved secrets** (for example `bru.getEnvVar`) and could send them on in a request or encode them in ways masking does not catch. Who may change a repo's scripts is controlled by review in Git.
- **Masking** skips values shorter than 4 characters, and does not catch a value inside Basic auth's encoded `user:password`.
- **Revealing** a secret's value in the interface is not available yet.
- **During a conflict**, the affected request shows as unreadable in the sidebar until a side is chosen, because the file holds Git's conflict markers.
- **No webhooks yet:** merge request status is read when the Git panel opens or is refreshed.
- **GitLab** is covered by unit tests only so far; it has not been run against a real GitLab instance.
