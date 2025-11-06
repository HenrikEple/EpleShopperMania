// server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(process.cwd(), 'public');

// Basic content types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json',
  '.glb':  'model/gltf-binary',
  '.bin':  'application/octet-stream'
};

function sendFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': /(\.html)$/i.test(ext) ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // Health checks
  if (req.method === 'HEAD' || req.url === '/health' || req.url === '/_health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Static files
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let fsPath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''); // strip traversal
  if (fsPath === '/' || fsPath === '') fsPath = '/index.html';
  const fullPath = path.join(PUBLIC_DIR, fsPath);
  sendFile(res, fullPath);
});

// WebSocket server on same port
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

  ws.send(JSON.stringify({ t: 'hello', id }));

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    // Relay to others, preserving sender id and payload shape
    broadcast({ t: msg.t, id, p: msg.p, id2: msg.p?.idx }, id);
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ t: 'remove', id });
  });
});

// Keep-alive pings so proxies don’t idle-close sockets
setInterval(() => {
  for (const [, ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server (HTTP+WS) listening on :' + PORT);
});