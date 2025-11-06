// server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8080;   // Railway sets PORT for you

// Basic HTTP server for health checks + landing text
const server = http.createServer((req, res) => {
  // Accept common probes
  if (req.method === 'HEAD' || req.url === '/health' || req.url === '/_health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// Attach WS to the same server (so it shares the same PORT)
const wss = new WebSocket.Server({ server });

const clients = new Map();
let nextId = 1;

function broadcast(json, exceptId = null) {
  const data = JSON.stringify(json);
  for (const [id, ws] of clients) {
    if (id === exceptId) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  clients.set(id, ws);

  // hello + (optional) snapshot
  ws.send(JSON.stringify({ t: 'hello', id }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // Relay with sender id preserved
    // Your client expects shapes like: { t, id, p } etc.
    broadcast({ t: msg.t, id, p: msg.p, id2: msg.p?.idx }, id);
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ t: 'remove', id });
  });
});

// IMPORTANT: listen on 0.0.0.0, not localhost
server.listen(PORT, '0.0.0.0', () => {
  console.log('WS server listening on :' + PORT);
});

// Optional: keepalive ping so idle proxies don’t drop sockets
const PING_MS = 25000;
setInterval(() => {
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, PING_MS);