// A stand-in for src/worker.js in the pool tests: same handshake, no Bruno.
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const SECRET = process.env.NARADO_WORKER_SECRET;
const USER = JSON.parse(process.env.NARADO_WORKER_USER || 'null');
const INSTANCE = crypto.randomUUID();
const ok = (req) => req.headers['x-narado-worker'] === SECRET;
const info = (req) => ({
  user: USER,
  dataDir: process.env.BRUNO_WEB_DATA_DIR,
  headers: req.headers,
  envKeys: Object.keys(process.env).filter((k) => k.startsWith('NARADO_'))
});

const waiting = new Map();
process.on('message', (m) => {
  if (m && m.type === 'rpc-result' && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const rpc = (method, args) =>
  new Promise((resolve) => {
    const id = crypto.randomUUID();
    waiting.set(id, resolve);
    process.send({ type: 'rpc', id, method, args });
  });

const server = http.createServer((req, res) => {
  if (!ok(req)) return res.writeHead(403).end();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(info(req)));
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!ok(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ t: 'instance', id: INSTANCE, ...info(req) }));
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'rpc') ws.send(JSON.stringify({ t: 'rpc', ...(await rpc(m.method, m.args)) }));
    });
  });
});
process.on('disconnect', () => process.exit(0));
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port, instance: INSTANCE, handlers: 0 }));
