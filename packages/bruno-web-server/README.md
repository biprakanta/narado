# bruno-web-server

Runs Bruno in a browser. This server loads Bruno's main-process code (`packages/bruno-electron/src`) in plain Node.js, with the `electron` module replaced by `src/electron-stub.js`, and relays IPC between the browser and Bruno's handlers over a WebSocket at `/ipc`. In the browser, `packages/bruno-app/src/web-bridge.js` provides `window.ipcRenderer` when Electron is not present.

Phase 1 of the design: single user, collections in folders on the server's disk. No sign-in yet, so it listens on `127.0.0.1` only and accepts WebSocket connections only from allowed origins.

## Run

From the repo root, after `npm run setup`:

```bash
node packages/bruno-web-server/src/server.js
```

```bash
npm run dev:web
```

Open http://localhost:3000. The rsbuild dev server forwards `/ipc` to the server on port 4100.

To serve a production build from the server itself instead, run `npm run build:web` and open http://localhost:4100.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `BRUNO_WEB_PORT` | `4100` | Server port |
| `BRUNO_WEB_HOST` | `127.0.0.1` | Address to listen on |
| `BRUNO_WEB_ORIGINS` | `http://localhost:3000`, `http://127.0.0.1:3000` and the server's own origin | Browser origins allowed to connect, comma-separated |
| `BRUNO_WEB_DATA_DIR` | `~/.bruno-web` | Preferences, app data and the local encryption key |
| `BRUNO_WEB_SERVER` | `http://127.0.0.1:4100` | Where the rsbuild dev server forwards `/ipc` |

## Known limits

- **Folder and file pickers** are a browser prompt asking for a path on the server.
- **Drag-and-drop file paths** are not available, because browsers don't expose them.
- **Turned off:** the built-in terminal (it would give a shell on the server), window controls and native menus.
- **Secrets** saved by Bruno are encrypted with a key file in the data folder. The design replaces this with a server-side secrets store in Phase 4.
