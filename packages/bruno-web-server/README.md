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
- **Phase 4a:** request safety: a platform block list for every connection, and each repo's host allowlist for every send.
- **Phase 4c:** each person connects their own GitHub or GitLab account, and narado works on Git as them.
- **Sync:** a one-click personal copy of any collection in your workspace, kept up to date without losing your edits.
- **Explore APIs:** a catalogue of every repository the person can see that holds collections, including code repositories that carry their API in a subfolder. One click opens one.

## Run

To run narado for a team (Docker, HTTPS, backups), see [`deploy/README.md`](deploy/README.md). For development, from the repo root, after `npm run setup`:

```bash
NARADO_GITHUB_TOKEN=<token> node packages/bruno-web-server/src/server.js
```

That uses one shared token, which is only for single-user local mode. With sign-in, set up the GitHub App instead (see Git accounts).

```bash
npm run dev:web
```

Open http://localhost:3000. The rsbuild dev server forwards `/ipc` to the server on port 4100.

To serve a production build from the server itself instead, run `npm run build:web` and open http://localhost:4100.

## Git hosts

Without a config file, GitHub.com and GitLab.com are available. For self-managed GitLab, or to change the list, create `<data dir>/narado.json`:

```json
{
  "hosts": [
    { "id": "github", "type": "github" },
    { "id": "acme-gitlab", "type": "gitlab", "url": "https://gitlab.acme.internal" }
  ]
}
```

Credentials never go in this file. They come from environment variables named after the host's id, as below (`acme-gitlab` reads `NARADO_ACME_GITLAB_APP_CLIENT_ID`, and so on).

### Git accounts

Each person connects their own Git account (Git section, Open from Git, Connect), and narado then works on the host as them: their own access, branch protection and audit trail apply. Shared tokens are not used once sign-in is on.

**GitHub** uses a GitHub App with user authorisation. Register one under Settings, Developer settings, GitHub Apps (or in your organisation's settings):

- Callback URL: `<public URL>/auth/github/callback`, wildcard matching off. Use the host's id in place of `github` for other GitHub hosts.
- Expire user authorisation tokens: on. Webhook: off.
- Repository permissions: Contents read and write, Pull requests read and write, Metadata read. Account permissions: Email addresses read.
- Generate a client secret. No private key is needed.

| Variable | Meaning |
|---|---|
| `NARADO_GITHUB_APP_CLIENT_ID` | The app's client ID |
| `NARADO_GITHUB_APP_CLIENT_SECRET` | Its client secret |
| `NARADO_GITHUB_APP_SLUG` | Its URL name, for the "give the app access" link |

A GitHub App reaches only the repositories it is installed on, so install it on your organisation (or the repositories narado should work on). Public repositories can be read without that.

**GitLab** uses an OAuth application (User settings, Applications, or an instance-wide one in the Admin area): redirect URI `<public URL>/auth/gitlab/callback`, confidential, scopes `api` and `read_user`. Set `NARADO_GITLAB_APP_CLIENT_ID` and `NARADO_GITLAB_APP_CLIENT_SECRET`; set `"scopes"` on the host in `narado.json` to ask for others.

How it is kept safe:

- Connecting uses the authorization code flow with PKCE and a one-time state, valid for 10 minutes and only for the narado person who started it.
- Tokens are stored in `narado.db`, encrypted (AES-256-GCM) with `NARADO_GIT_TOKEN_KEY` (32 bytes, base64) or, without it, a key file `narado-git-key` in the data folder. In production, set the variable from your secrets manager so the key is not next to the database.
- Refresh tokens and app credentials stay in the front process. A person's worker asks the front for an access token when it needs one, and the front refreshes it when it has under five minutes left. A refused refresh disconnects the account, and narado asks the person to connect again.
- Git commands get the token in an HTTP header for that command only, with credential helpers turned off, so nothing is saved on disk and nothing falls back to another account.
- Disconnecting deletes the stored tokens and withdraws narado's access on the host.
- **Same person?** The Git account's verified emails are compared with the person's sign-in email. By default a mismatch is shown (Explore APIs warns); `NARADO_GIT_ACCOUNT_MATCH=require` refuses the connection, and `off` skips the check.
- One Git account can be connected by one narado person only, so the host's records always name the person who acted. A second person trying to connect the same account (for example on a shared computer) is refused and told to sign in to the host as themselves.

### Shared tokens (local mode)

Without sign-in, a host can use one token from `NARADO_<HOST ID>_TOKEN` instead (set `"tokenEnv"` on a host for another name):

| Host | Variable | Token needs |
|---|---|---|
| GitHub.com (`github`) | `NARADO_GITHUB_TOKEN` | `repo` scope (classic), or Contents and Pull requests read/write (fine-grained) |
| GitLab.com (`gitlab`) | `NARADO_GITLAB_TOKEN` | `api` scope |

With sign-in on, these are ignored unless `NARADO_SHARED_GIT_TOKENS=1`, which is only meant for moving a server over. Workers never see them: the front hands them out like personal tokens.

### OpenAPI collections

An OpenAPI collection is a folder holding a spec and narado's own folder, `.narado/`, beside it:

```
services/payments/api/
  payments-v2.yaml          the spec, any name
  .narado/
    config.nar              marks the collection and names the spec
    requests/<operationId>.yml   values, scripts and tests per request
    allowed-hosts.yml       hosts requests may reach (see Request safety)
    extra/                  GraphQL, gRPC and WebSocket requests, as Bruno files
```

`config.nar` is YAML:

```yaml
version: 1
name: Payments API        # optional; defaults to the spec's info.title
spec: payments-v2.yaml    # relative to this folder, and inside it
grpc:                     # optional, for gRPC requests
  protoFiles: [../../proto/payments/v1.proto]   # relative to this folder, inside the repo
  importPaths: [../../proto]
```

**GraphQL, gRPC and WebSocket requests** can't be described in OpenAPI, so narado keeps them as Bruno files in `.narado/extra/`, at the same folder path as in the collection. They're created, edited and reviewed like everything else; the spec is never touched by them. gRPC proto files and import paths come from `config.nar`; choosing them in the collection's Protobuf settings writes them back there, and light clones also fetch the folders they're in. All three follow the same request rules as HTTP: a WebSocket or gRPC host must be on the repo's allowlist (`.narado/allowed-hosts.yml`, as `host:port`).

Without `config.nar`, a folder holding `openapi.yaml`, `openapi.yml` or `openapi.json` (in that order) is a collection too, and narado creates `.narado/` there when it first needs to save something. Collections made before `.narado/` keep their files in `.client/`, which narado still reads and writes for them.

### Explore APIs

The **Explore APIs** button in the Git section lists every repository the person can see that holds a collection, found through the host's API as them. Nothing is cloned until they open one.

- **What counts as a collection,** in order: a folder with `.narado/config.nar` (the spec it names); with `bruno.json` or `opencollection.yml` (Bruno); or with `openapi.yaml`, `openapi.yml` or `openapi.json`. A `config.nar` that names a missing spec is listed with the problem. Copies and other people's code are skipped: `node_modules`, `vendor`, `third_party`, `dist`, `build`, `target`, `out` and hidden folders.
- **Where to look:** by default, every repository the person can see. **Looking in → Change** narrows it to chosen users, organisations or groups (GitLab subgroups included). Then only those are listed, and nothing else the account can see is asked for: useful when one Git account also belongs to organisations narado shouldn't read. A host in `narado.json` can set a default for everyone: `"exploreNamespaces": ["acme", "acme-platform"]`. MCP's `explore_apis` follows the same choice.
- **Two kinds of repository:** an **API repo** has its collection at the root. A **Code + API** repo is a service that carries its API in subfolders, for example `api/openapi.yaml` or several `services/*/api/` folders.
- **Cost:** one file-list call per repository, plus one call per collection for its name. Results are cached in the person's folder per repository, keyed by its default branch and last push, so later visits only read repositories that changed. If the host rate-limits narado, it stops and carries on next time.
- **Opening** a collection opens the repository's default branch, with every collection in it, and shows the one chosen. Edits are saved to a branch or fork as usual. **Change or branch…** opens the full dialog.
- **Right after sign-in,** a person with no Git account connected is sent to connect one, once per browser session. If GitHub has already authorised the app for the account signed in to that browser, this returns at once with no prompt.

### Sync to your workspace

Next to **Open**, each collection in Explore APIs has **Sync**: one action that copies the collection from the repository's default branch into the person's own workspace, as an ordinary collection named "… (synced)". It is theirs to use and change; nothing goes back to Git. The Git section lists synced copies with **Sync** to update them.

- **Syncing again** brings in what changed on the default branch, file by file. Files the person hasn't touched are updated or removed; files they edited are kept and reported ("kept your edits to 1 file"); files they deleted stay deleted.
- **Same rules as the repo.** A copy counts as part of the repository it came from: requests must match that repository's allowlist, and secrets rules see that repository.
- **Where:** `<person's folder>/synced/<host>/<repo>/<folder>`; what was synced, from which commit, is in `synced-state.json`.
- Use **Open** to change the collection for everyone (through a pull request), **Sync** to use it yourself.

### How workspaces work

- **One bare clone per repo**, under `<data dir>/git/<host>/<owner>/<repo>.git`, plus **one Git worktree per branch** under `<data dir>/git/<host>/<owner>/<repo>/worktrees/`.
- **Start a change** creates `narado/<login>/<topic>` from the default branch. **Browse** opens the default branch read-only. Commits to the default branch are refused, since changes go through merge requests.
- **Commit** stages everything in the working copy. **Push and open** pushes and opens a pull request (GitHub) or merge request (GitLab) into the default branch.
- **Update from main** merges the default branch in. Conflicts are listed per file with **Keep mine** or **Keep main**, and the update can be cancelled.
- **Code repositories are cloned lightly.** When a repository's collections are all in subfolders, narado clones it without file contents (`--filter=blob:none`) and checks out only those folders plus the files at the root (sparse checkout, cone mode). Git fetches other contents only if a command needs them, for example a merge touching files outside those folders. A collection folder added to the repository later is added the next time it is opened. API repos (collection at the root) are cloned in full. `NARADO_SPARSE_CLONES=0` turns this off.
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

## Request safety

With sign-in on, a person's requests run on the server, so narado stops them reaching what they shouldn't (server-side request forgery). Both checks run inside Node's networking in each worker, so they also cover scripts' own requests, redirects, OAuth 2 token calls, WebSockets, gRPC and proxies.

**Platform block list: every connection a worker opens.**

- Checked on the addresses a name resolves to, so a public name pointing at a blocked address is refused, as is any IP spelling (IPv4-mapped IPv6 and so on).
- **Always refused:** loopback, link-local and cloud metadata (`169.254.169.254`, `fd00:ec2::254`), unspecified, multicast, broadcast, and local sockets.
- **Refused unless opened:** private and shared ranges (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`) and other special-purpose ranges. `NARADO_ALLOWED_NETWORKS` opens internal ranges your APIs live in.
- `NARADO_BLOCKED_NETWORKS` adds ranges, such as the server's own cluster network, and wins over `NARADO_ALLOWED_NETWORKS`.
- Configured Git hosts (`narado.json`) may be on private addresses, never on the always-refused ones.
- This also covers requests that aren't sends, such as importing a spec from a URL.

**Repo allowlist: every request made during a send.**

A request may only go to hosts the repo names on its **default branch**. A host added on a branch counts once its merge request is merged. The hosts come from three places:

- `.narado/allowed-hosts.yml` (`.client/` in older collections), at the root or next to a collection in a code repository (for example `services/payments/api/.narado/allowed-hosts.yml`):

  ```yaml
  hosts:
    - api.stripe.com                 # ports 80 and 443
    - "*.sandbox.acme.com"           # any subdomain
    - api.acme.com:8443              # that port
    - host: payments.acme.com        # or in full
      ports: [443, 8443]
      paths: ["/v1/", "/health"]     # path prefixes
  ```

- URLs in the OpenAPI spec's `servers`.
- Literal URLs in environment files.

How the check works:

- **Each HTTP request is checked** (host, port and path), including reused keep-alive connections. Other connections are checked by host and port.
- **Review the file.** The Git panel lists the hosts and warns when `CODEOWNERS` doesn't cover every `allowed-hosts.yml` in the repo (a `.narado/` line covers them all). It also asks the host, as the person, whether the default branch requires code-owner review (GitHub rulesets or branch protection, GitLab protected branches), and says so; when the details need admin rights it says it can't tell. Add one, and turn on code-owner review in branch protection, so allowlist changes need approval.
- **Collections outside a Git workspace** only get the block list. Set `NARADO_REQUESTS_OUTSIDE_REPOS=refuse` to stop their sends.
- **MCP sends** use the same default-branch allowlist, also in single-user mode.

**Log.** Each request in a send is logged with the person, method, host, port, repo and status, or why it was refused. Paths, queries, headers and bodies are not logged.

Without sign-in, narado is a local tool and neither check applies to the interface, so `localhost` works. `NARADO_REQUEST_RULES=1` turns them on anyway; `0` turns them off with sign-in, for debugging only.

## Secrets

Secrets stay in the organisation's secrets store. An environment variable holds a **reference**, which is committed to Git like any other value:

```
secret://<store>/<path>[#<field>]       for example  secret://vault/payments/staging#api_key
```

- **When a request is sent,** the person's worker asks the front for the values of the references in it. The front checks access, reads the store and answers. The worker swaps the references for values, only for sending: saving an environment never resolves anything.
- **Values reach the browser only when asked for.** In everything a worker sends back (responses, timelines, script output, MCP results), a string that is exactly a secret's value turns back into its reference, and any other occurrence is masked as `••••••`, also when URL- or base64-encoded.
- **Store credentials never reach a worker.** They are read by the front from `NARADO_SECRETS_<STORE ID>_*` variables, which workers do not get.
- **Rules that name repositories** only count when the person can really read that repository: the front asks the host, as them, before applying them (cached for five minutes).
- **Every read is logged** by the front with the person, store, path, repo and outcome, never the value. Values are cached for 60 seconds (`NARADO_SECRETS_CACHE_SECONDS`); access is checked every time.
- **Picker:** Secrets (in the Git section's menu) browses the stores (only what you may use), builds a reference and checks it without showing the value.
- **Reveal:** the same dialog can show a value on purpose, for 30 seconds, with the same access rules as a send. Each reveal is logged (`revealed`), and `NARADO_SECRETS_REVEAL=0` turns it off. Reveals never go through MCP.

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
- **Read** tokens can find APIs across the person's repositories (`explore_apis`), list hosts, repos, workspaces, collections, requests and environments, read requests and OpenAPI specs, sync a personal copy of a collection (`sync_collection`), and send requests: HTTP and GraphQL (`send_request`), WebSocket (`send_websocket`, which sends the messages and collects replies for a few seconds) and gRPC (`call_grpc`). In a repository with several collections, tools take a `collection` folder (from `list_collections`).
- **Read and write** tokens can also edit requests (`update_request`) and save changes (`save_changes`: a new branch or fork plus a merge request, or a commit on a change branch). Merge requests opened this way name the person and the token.
- The token is shown once; only its SHA-256 hash is stored, in `<data dir>/mcp-tokens.json`. Tokens can be revoked from the same dialog.
- `NARADO_MCP_ALLOW_WRITE=0` turns write tools off for every token.

**Sending requests.** The send tools only reach hosts on the repo's allowlist from its default branch (see Request safety). Pre- and post-request scripts and tests do not run for MCP sends, because they could change the target or make their own calls. Secrets are masked in tool results.

**Other protections.** Requests with a browser `Origin` are refused, and the `Host` header must be the server's own address.

To add narado to Claude Code (the dialog shows this command with your token filled in):

```bash
claude mcp add --transport http narado http://127.0.0.1:4100/mcp --header "Authorization: Bearer <token>"
```

`scripts/mcp-smoke.js` exercises the endpoint with the MCP SDK's client.

## OAuth 2 sign-ins to APIs

When a request's OAuth 2 settings leave *Callback URL* empty, narado uses its own page, `<narado address>/oauth2/callback`, instead of Bruno's `oauth.usebruno.com`. Register that one address with the API's OAuth provider; it works for the web version and narado desktop alike, and nothing passes through Bruno's servers.

- **Web:** the sign-in opens in the person's browser (the web version has no app window, so *Use system browser* is always on). The provider sends them back to the callback page. The page posts the result to `/oauth2/callback/complete` on the same site, and narado gives it only to the signed-in person's own worker, if it's waiting for a sign-in. The worker checks `state`, exchanges the code and carries on with the request.
- **Desktop:** in the app's sign-in window, narado catches the redirect before the page loads. In the system browser, the page hands the result to narado desktop through `narado://app/oauth2/callback`; narado desktop registers `narado://` and leaves `bruno://` to Bruno.
- **Implicit flow:** tokens arrive after `#` in the address, which browsers never send to a server, so the page reads them itself. It then clears the result from the address bar.
- **Several narado tabs:** questions from a person's worker back to the browser, such as opening a sign-in page or a confirm, go to the tab whose request asked.

## Setup and admin pages

narado's own pages at `/setup` and `/admin` (`src/narado/admin.js`), served by the front so they work before sign-in is configured.

- **First start:** until admins are named, narado prints a one-time setup link in its log (`[narado] SETUP: open …/setup?token=…`). A new link is printed at each start, and only the latest works. Opening it gives that browser a setup session. If narado listens beyond this computer without sign-in, it serves only the setup pages.
- **Setup:** set sign-in (OpenID Connect: issuer, client, allowed email domains, narado's address) and the admins (`NARADO_ADMINS`), then sign in with SSO as an admin. The setup link then stops working.
- **Admin pages** (signed-in admins; the Git section's ⋯ menu shows *Admin settings* to them):
  - sign-in and admins;
  - Git hosts: add GitHub Enterprise or self-managed GitLab, and set where Explore looks by default;
  - the desktop send policy;
  - every person's signed-in computers, with sign-out;
  - secrets stores (Vault, AWS Secrets Manager, Google Cloud Secret Manager, Azure Key Vault) as connector cards. An admin can add or remove a store, or change its settings and credentials. Credentials are encrypted as settings under the names the stores read (`NARADO_SECRETS_<ID>_*`), and the store's location goes in `narado.json`. *Test connection* lists the store's top level and shows only a count: as narado for service-identity stores, as the admin for per-person ones. Removing a store removes its access rules. The access rules themselves are still edited in `narado.json`.
- **Git apps, created by narado:**
  - **GitHub and GitHub Enterprise:** *Create the GitHub App* uses GitHub's app-manifest flow. GitHub creates a private app in the given organisation (or the admin's account) with the needed permissions and callback, then narado exchanges the one-time code for its credentials and offers the install link.
  - **Self-managed GitLab:** an administrator access token creates the OAuth application through the API. narado doesn't keep the token.
  - **GitLab.com:** there's no API for this, so the page shows exactly what to create and where to paste it.
  - Credentials can also be entered by hand.
- **Where settings live:** saved settings go in `narado.db` under the names of the environment variables they replace. Secrets (client secrets, the GitHub App's private key) are encrypted with narado's token key. A variable set in the environment always wins, and the pages show it as locked. Saving restarts narado's front in place; people's workers restart with it.

## narado desktop

narado desktop (`npm run dev:narado-desktop` from the repository root, design in the design repo's `docs/desktop.md`) runs a person's worker on their own computer and uses this server as its front, over HTTPS. It needs sign-in to be configured.

- **Signing in a computer:** the app opens `/auth/desktop/start` in the system browser with a loopback address (`http://127.0.0.1:<port>/callback`), PKCE and a state. The person signs in as usual and approves the computer on narado's page. The one-time code goes only to the loopback address and is exchanged at `POST /desktop/api/token`.
- **Device sessions:** each computer gets a refresh token, which rotates on use, expires after 30 days unused (1 year at most) and is kept with the OS's secure storage (Keychain, DPAPI, libsecret). It also gets a 1-hour access token held in memory. Reusing an old refresh token signs the device out. People see their computers under **Devices** (Git section, ⋯ menu) and can sign any of them out; that takes effect at the device's next contact.
- **The channel** (`/desktop/api/*`, Bearer token; requests with a browser `Origin` are refused) carries only `git.status`, `git.token`, `git.disconnect`, `secrets.*` and `devices.*`, checked as the person, as for a worker. The server logs each Git token and each secret resolved for a device, and every send a device reports (person, device, method, host, repository, status; no paths, headers or bodies).
- **Git accounts** are connected in the system browser and stay on the server. The desktop caches Git access tokens in memory for at most 10 minutes.
- **What the desktop may send** (`src/narado/requests/desktop-guard.js`): cloud metadata and other link-local addresses never. Private and local addresses (localhost, the person's network, VPN) always, without being listed. Public hosts only if they're on the repo's allowlist from its default branch, path included. Collections outside Git can send anywhere not blocked. `NARADO_DESKTOP_SEND` narrows this: `private-only`, or `allowlist-only` (every send listed, nothing outside a repo). narado's own server and Git hosts are checked only against the blocked addresses.
- **Offline:** working copies reopen, edits, commits and sends to reachable hosts work. Secret values resolved in the last 8 hours on that computer are reused, from memory only. Push, pull, new secrets and Explore scans need a connection; Explore shows its cached results. Send reports wait on disk (`pending-send-reports.json`: time, method, host, repository, status) and arrive marked "offline" when the app reconnects. It tries every 30 seconds, and a proxy's 502–504 counts as unreachable.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BRUNO_WEB_PORT` | `4100` | Server port |
| `BRUNO_WEB_HOST` | `127.0.0.1` | Address to listen on |
| `BRUNO_WEB_ORIGINS` | `http://localhost:3000`, `http://127.0.0.1:3000` and the server's own origin | Browser origins allowed to connect, comma-separated |
| `BRUNO_WEB_DATA_DIR` | `~/.bruno-web` | Sign-in database, MCP tokens, `narado.json`; with sign-in, each person's folder under `users/` |
| `BRUNO_WEB_SERVER` | `http://127.0.0.1:4100` | Where the rsbuild dev server forwards `/ipc`, `/auth` and `/desktop/api` |
| `NARADO_<HOST ID>_APP_CLIENT_ID`, `_APP_CLIENT_SECRET`, `_APP_SLUG` | none | The GitHub App or GitLab application people connect their accounts through (see Git accounts) |
| `NARADO_GIT_TOKEN_KEY` | a key file in the data folder | 32 bytes, base64: encrypts stored Git tokens |
| `NARADO_<HOST ID>_TOKEN` | none | Shared token for a Git host, local mode only |
| `NARADO_SPARSE_CLONES` | on | `0` clones code repositories in full instead of fetching only their collection folders |
| `NARADO_GIT_ACCOUNT_MATCH` | `warn` | Compare a Git account's verified emails with the sign-in email: `warn`, `require` (refuse a mismatch) or `off` |
| `NARADO_SHARED_GIT_TOKENS` | off | `1` lets signed-in people use shared tokens when they have not connected an account |
| `NARADO_MCP_ALLOW_WRITE` | on | `0` turns MCP write tools off for every token |
| `NARADO_WORKER_IDLE_MINUTES` | `30` | Stop a person's worker after this long without a connection |
| `NARADO_MAX_WORKERS` | `50` | Most workers at once; when full, the longest-idle one makes room, or new people get 503 |
| `NARADO_WORKER_SANDBOX` | on with sign-in | `0` runs workers without Node's permission model. Only for debugging |
| `NARADO_REQUEST_RULES` | on with sign-in | Block list and repo allowlists (see Request safety); `0` off, `1` on |
| `NARADO_ALLOWED_NETWORKS` | none | Internal ranges requests may reach, comma-separated CIDRs |
| `NARADO_BLOCKED_NETWORKS` | none | Extra ranges to refuse; wins over `NARADO_ALLOWED_NETWORKS` |
| `NARADO_REQUESTS_OUTSIDE_REPOS` | `allow` | `refuse` stops sends from collections outside a Git workspace |
| `NARADO_SECRETS_<STORE ID>_*` | none | Secrets store credentials (see Secrets) |
| `NARADO_SECRETS_CACHE_SECONDS` | `60` | How long the front keeps a secret's value |
| `NARADO_SECRETS_REVEAL` | on | `0` stops people seeing secret values in the Secrets dialog (Reveal) |
| `NARADO_ADMINS` | none | Admin emails, comma-separated (or set in the admin pages) |
| `NARADO_DESKTOP_SEND` | `any` | What narado desktop may send to: `any`, `private-only` or `allowlist-only` (see narado desktop) |

## Tests

```bash
npm test --workspace=packages/bruno-web-server
```

The workspace tests run real Git against a local repo standing in for the host, including merge conflicts. The provider tests use a fake HTTP layer.

## Known limits

- **Git accounts and sign-in** are matched by verified email, which only works when people use their work email on the Git host; otherwise set `NARADO_GIT_ACCOUNT_MATCH=off` and rely on one account per person.
- **Partial clones need the host for some local commands.** Reading a file Git hasn't fetched yet (a merge outside the collection folders, an allowlist file) contacts the host with the person's token, so it fails while the host is unreachable or the account is disconnected.
- **Repositories cloned before light clones** become light the next time they're opened, but only when nothing local could be lost: at most a clean copy of the default branch, and every local branch already on the host. Otherwise they stay full and keep working.
- **Access tokens reach the worker.** Workers get short-lived access tokens (GitHub: 8 hours, GitLab: 2 hours) for the calls they make, never refresh tokens.
- **The sandbox has gaps.**
  - Workers run as the same operating-system account as the front.
  - Child processes (git, and the shell Bruno reads its environment from) are not covered by Node's permission model; narado builds their arguments itself.
  - Native add-ons are allowed, for file watching.
  - Network rules (Request safety) are enforced in the worker itself; a container per worker with its own egress rules adds a second layer.
  - For a hosted service, run each worker in its own container or OS user as well.
- **Request rules and other programs.** The block list and allowlists are applied inside the worker's Node process; programs it starts (git) are not covered, but their targets are narado's configured Git hosts. Names are resolved once per connection, by the system resolver.
- **The allowlist's repo** is found from the collection's folder; a person's worker reads it from its own clone of the default branch, fetched with their own Git account.
- **Data from before Phase 4d** at the top of the data folder is not moved into anyone's `users/` folder; people re-open their repositories.
- **fsync** is skipped inside sandboxed workers, because Node's permission model refuses it, so a power cut can lose the last settings write.

- **Folder and file pickers** are a browser prompt asking for a path on the server.
- **Drag-and-drop file paths** are not available, because browsers don't expose them.
- **Turned off:** the built-in terminal (it would give a shell on the server), window controls and native menus.
- **Bruno's own secret variables** (the "secret" checkbox) still work, encrypted with a key file in each person's folder. Prefer `secret://` references, which keep values in the organisation's store.
- **Scripts can read resolved secrets** (for example `bru.getEnvVar`) and could send them on in a request or encode them in ways masking does not catch. Who may change a repo's scripts is controlled by review in Git.
- **Masking** skips values shorter than 4 characters, and does not catch a value inside Basic auth's encoded `user:password`.
- **During a conflict**, the affected request shows as unreadable in the sidebar until a side is chosen, because the file holds Git's conflict markers.
- **No webhooks yet:** merge request status is read when the Git panel opens or is refreshed.
- **GitLab** has been tried against GitLab.com (connecting an account, a light clone, a merge request); self-managed GitLab uses the same code but hasn't been tried.
