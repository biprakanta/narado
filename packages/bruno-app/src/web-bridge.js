/**
 * Browser replacement for the `window.ipcRenderer` bridge that Electron's
 * preload script (packages/bruno-electron/src/preload.js) provides.
 *
 * Only installed when the app runs outside Electron. Calls are relayed over a
 * WebSocket to packages/bruno-web-server, which runs Bruno's main-process code.
 */
const installWebBridge = () => {
  if (typeof window === 'undefined' || window.ipcRenderer) return;

  const wsUrl = () => {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}/ipc`;
  };

  const listeners = new Map(); // channel -> Set<handler>
  const pending = new Map(); // invoke id -> { resolve, reject }
  const outbox = []; // messages queued while the socket is not open
  let socket;
  let nextId = 1;
  let reconnectDelay = 500;

  // JSON turns `undefined` in an array into `null`, but Electron's IPC keeps it,
  // and Bruno's handlers rely on that (default parameters only apply to undefined).
  // So send the positions of undefined arguments alongside and restore them.
  const encodeArgs = (args) => ({
    args: args.map((a) => (a === undefined ? null : a)),
    u: args.reduce((acc, a, i) => (a === undefined ? [...acc, i] : acc), [])
  });
  const decodeArgs = (args = [], u = []) => {
    const out = args.slice();
    for (const i of u) out[i] = undefined;
    return out;
  };

  const deliver = (channel, args) => {
    const handlers = listeners.get(channel);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(...(args || []));
      } catch (err) {
        console.error(`[web-bridge] listener for ${channel} failed`, err);
      }
    }
  };

  const post = (msg) => {
    const data = JSON.stringify(msg);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
    else outbox.push(data);
  };

  // Native UI the server asks the browser to show (stand-ins for Electron dialogs).
  const answerServerRequest = async (kind, payload = {}) => {
    switch (kind) {
      case 'dialog:open': {
        const wantsFolder = (payload.properties || []).includes('openDirectory');
        const multi = (payload.properties || []).includes('multiSelections');
        const label = payload.title || (wantsFolder ? 'Choose a folder' : 'Choose a file');
        const answer = window.prompt(
          `${label}\n\nEnter a path on the server${multi ? ' (separate several with commas)' : ''}:`,
          payload.defaultPath || ''
        );
        if (!answer || !answer.trim()) return { canceled: true, filePaths: [] };
        const filePaths = multi ? answer.split(',').map((p) => p.trim()).filter(Boolean) : [answer.trim()];
        return { canceled: false, filePaths };
      }
      case 'dialog:save': {
        const answer = window.prompt(`${payload.title || 'Save as'}\n\nEnter a path on the server:`, payload.defaultPath || '');
        return answer && answer.trim() ? { canceled: false, filePath: answer.trim() } : { canceled: true };
      }
      case 'dialog:message': {
        const buttons = payload.buttons || ['OK'];
        const text = [payload.title, payload.message, payload.detail].filter(Boolean).join('\n\n');
        if (buttons.length <= 1) {
          window.alert(text);
          return { response: 0, checkboxChecked: false };
        }
        // Two or more buttons: OK picks the first, Cancel the last.
        return { response: window.confirm(text) ? 0 : buttons.length - 1, checkboxChecked: false };
      }
      case 'shell:open-external':
        window.open(payload.url, '_blank', 'noopener,noreferrer');
        return true;
      default:
        return undefined;
    }
  };

  const connect = () => {
    socket = new WebSocket(wsUrl());

    socket.addEventListener('open', () => {
      reconnectDelay = 500;
      socket.send(JSON.stringify({ t: 'hello' }));
      while (outbox.length) socket.send(outbox.shift());
    });

    socket.addEventListener('message', async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'res') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      } else if (msg.t === 'evt') {
        deliver(msg.ch, decodeArgs(msg.args, msg.u));
      } else if (msg.t === 'req') {
        let value;
        try {
          value = await answerServerRequest(msg.kind, msg.payload);
        } catch (err) {
          console.error('[web-bridge] request failed', err);
        }
        post({ t: 'reqres', id: msg.id, value });
      }
    });

    socket.addEventListener('close', () => {
      // Calls in flight cannot complete; fail them so the UI does not hang.
      for (const [id, p] of pending) {
        p.reject(new Error('Lost connection to the Bruno server'));
        pending.delete(id);
      }
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });
  };

  window.ipcRenderer = {
    invoke(channel, ...args) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        post({ t: 'invoke', id, ch: channel, ...encodeArgs(args) });
      });
    },
    send(channel, ...args) {
      post({ t: 'send', ch: channel, ...encodeArgs(args) });
    },
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
      return () => listeners.get(channel)?.delete(handler);
    },
    removeAllListeners(channel) {
      if (channel) listeners.delete(channel);
      else listeners.clear();
    },
    // Browsers do not expose file system paths for dropped or picked files.
    getFilePath() {
      return undefined;
    },
    openExternal(url) {
      if (!/^(https?|mailto):/i.test(url)) return Promise.reject(new Error('Blocked URL scheme'));
      window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve();
    }
  };

  window.isBrunoWeb = true;
  connect();
};

installWebBridge();
