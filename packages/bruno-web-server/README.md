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

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BRUNO_WEB_PORT` | `4100` | Server port |
| `BRUNO_WEB_HOST` | `127.0.0.1` | Address to listen on |
| `BRUNO_WEB_ORIGINS` | `http://localhost:3000`, `http://127.0.0.1:3000` and the server's own origin | Browser origins allowed to connect, comma-separated |
| `BRUNO_WEB_DATA_DIR` | `~/.bruno-web` | Preferences, app data, Git workspaces and the local encryption key |
| `BRUNO_WEB_SERVER` | `http://127.0.0.1:4100` | Where the rsbuild dev server forwards `/ipc` |
| `NARADO_<HOST ID>_TOKEN` | none | Token for a Git host (see above) |

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
