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
  let instanceId = null; // the server worker this page is talking to

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

  // Events that arrive before the app has registered a listener for them (the server
  // sends startup events as soon as the socket opens, which can beat React's first
  // effects) are held briefly and replayed when a listener registers.
  const early = []; // { channel, args, at }
  const EARLY_MS = 30 * 1000;

  const deliver = (channel, args) => {
    if (channel === 'main:app-loaded' && bootScreen) bootScreen.hide();
    const handlers = listeners.get(channel);
    if (!handlers || !handlers.size) {
      if (early.length < 1000) early.push({ channel, args, at: Date.now() });
      return;
    }
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
        // The in-app folder browser (components/Narado/ServerFileDialog.js) once the app has loaded.
        if (window.__naradoServerDialog) return window.__naradoServerDialog({ kind: 'open', ...payload });
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
        if (window.__naradoServerDialog) return window.__naradoServerDialog({ kind: 'save', ...payload });
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
      if (msg.t === 'instance') {
        // A different id after reconnecting means a new worker on the server (restarted, or
        // stopped while idle): its state starts fresh, so reload to match it.
        if (instanceId && msg.id !== instanceId) return window.location.reload();
        instanceId = msg.id;
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

    socket.addEventListener('close', async () => {
      if (window.naradoAuth && window.naradoAuth.mode === 'oidc') {
        const res = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
        if (res && res.status === 401) return window.naradoAuth.signIn();
      }
      // Calls in flight cannot complete; fail them so the UI does not hang.
      for (const [id, p] of pending) {
        p.reject(new Error('Lost connection to the narado server'));
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
      const now = Date.now();
      for (let i = 0; i < early.length;) {
        const ev = early[i];
        if (now - ev.at > EARLY_MS) early.splice(i, 1);
        else if (ev.channel === channel) {
          early.splice(i, 1);
          setTimeout(() => deliver(channel, ev.args), 0);
        } else i++;
      }
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

  // narado branding: page title and icons (assets in public/narado, from branding/icons).
  document.title = 'narado';
  const icon = (rel, href, extra = {}) => {
    const link = document.createElement('link');
    Object.assign(link, { rel, href }, extra);
    document.head.appendChild(link);
  };
  document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
  icon('icon', '/narado/narado-favicon.svg?v=2', { type: 'image/svg+xml' });
  icon('alternate icon', '/narado/favicon.ico?v=2', { sizes: '16x16 32x32 48x48' });
  icon('apple-touch-icon', '/narado/favicon-180.png?v=2');

  // Start-up screen: the veena loader until Bruno's main process says the app has loaded.
  const bootScreen = (() => {
    let stored = 'system';
    try {
      stored = JSON.parse(localStorage.getItem('bruno.theme') || '"system"');
    } catch {}
    const dark = stored === 'dark' || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const el = document.createElement('div');
    el.id = 'narado-boot';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-label', 'Loading narado');
    el.style.cssText = `position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;`
      + `background:${dark ? '#17121F' : '#FFFFFF'};color:${dark ? '#C7BCCB' : '#5E5267'};font:500 14px system-ui,-apple-system,sans-serif;transition:opacity .25s`;
    el.innerHTML = `<img src="/narado/narado-loader-${dark ? 'dark' : 'light'}.svg" width="96" height="96" alt=""><span>Starting narado…</span>`;
    const mount = () => document.body.appendChild(el);
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
    let done = false;
    const hide = () => {
      if (done) return;
      done = true;
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    };
    setTimeout(hide, 20000); // never block the app if the event is missed
    return { hide };
  })();

  // Move browsers still on Bruno's default themes to narado's, once. A theme someone
  // picked themselves (anything but the old defaults) is left alone.
  try {
    if (!localStorage.getItem('narado.themesMigrated')) {
      for (const [key, oldDefault, naradoTheme] of [
        ['bruno.themeVariantLight', 'light', 'narado-light'],
        ['bruno.themeVariantDark', 'dark', 'narado-dark']
      ]) {
        const current = localStorage.getItem(key);
        if (current === null || current === JSON.stringify(oldDefault)) localStorage.setItem(key, JSON.stringify(naradoTheme));
      }
      localStorage.setItem('narado.themesMigrated', '1');
    }
  } catch {}

  // Sign-in (narado Phase 4b): without a session, go to the provider and come back here.
  const signIn = () => {
    const back = window.location.pathname + window.location.search;
    window.location.assign(`/auth/login?return=${encodeURIComponent(back)}`);
  };
  window.naradoAuth = { mode: 'unknown', user: null, signIn };

  fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return signIn();
      window.naradoAuth = { ...window.naradoAuth, mode: data.mode || 'local', user: data.user || null, isAdmin: !!data.isAdmin };
      window.dispatchEvent(new CustomEvent('narado:auth', { detail: window.naradoAuth }));
      connect();
    })
    .catch(() => connect()); // older servers without /auth: carry on in local mode
};

installWebBridge();
