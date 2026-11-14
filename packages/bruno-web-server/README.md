# bruno-web-server

The server half of narado. It runs Bruno in a browser: it loads Bruno's main-process code (`packages/bruno-electron/src`) in plain Node.js, with the `electron` module replaced by `src/electron-stub.js`, and relays IPC between the browser and Bruno's handlers over a WebSocket at `/ipc`. In the browser, `packages/bruno-app/src/web-bridge.js` provides `window.ipcRenderer` when Electron is not present.

- **Phase 1:** Bruno in the browser, single user, collections in folders on the server's disk.
- **Phase 2:** Git-backed workspaces on GitHub and GitLab (`src/narado/`, and the **Git** section in the sidebar from `packages/bruno-app/src/components/Narado/`).

There is no sign-in yet, so the server listens on `127.0.0.1` only and accepts WebSocket connections only from allowed origins.

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
- **Until Phase 4d,** signed-in people still share one Bruno process on the server, so they see the same open collections. Don't rely on separation between users yet.

For local development, `dev/keycloak/` has a realm with two test users and the exact commands.

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
| `BRUNO_WEB_DATA_DIR` | `~/.bruno-web` | Preferences, app data, Git workspaces and the local encryption key |
| `BRUNO_WEB_SERVER` | `http://127.0.0.1:4100` | Where the rsbuild dev server forwards `/ipc` |
| `NARADO_<HOST ID>_TOKEN` | none | Token for a Git host (see above) |
| `NARADO_MCP_ALLOW_WRITE` | on | `0` turns MCP write tools off for every token |

## Tests

```bash
npm test --workspace=packages/bruno-web-server
```

The workspace tests run real Git against a local repo standing in for the host, including merge conflicts. The provider tests use a fake HTTP layer.

## Known limits

- **Folder and file pickers** are a browser prompt asking for a path on the server.
- **Drag-and-drop file paths** are not available, because browsers don't expose them.
- **Turned off:** the built-in terminal (it would give a shell on the server), window controls and native menus.
- **Secrets** saved by Bruno are encrypted with a key file in the data folder. The design replaces this with a server-side secrets store in Phase 4.
- **During a conflict**, the affected request shows as unreadable in the sidebar until a side is chosen, because the file holds Git's conflict markers.
- **No webhooks yet:** merge request status is read when the Git panel opens or is refreshed.
- **GitLab** is covered by unit tests only so far; it has not been run against a real GitLab instance.
