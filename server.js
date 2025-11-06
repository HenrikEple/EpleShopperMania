// server.js — HTTP static + WebSocket relay (ESM)
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { stat, createReadStream } from "fs";
import { join, extname, normalize } from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.PORT) || 8080;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

// --- tiny static server (serves /public) + health ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".gltf": "model/gltf+json",
  ".glb":  "model/gltf-binary",
  ".bin":  "application/octet-stream",
  ".wav":  "audio/wav",
  ".mp3":  "audio/mpeg"
};

const httpServer = createServer((req, res) => {
  // health endpoints Railway can probe
  if (req.method === "HEAD" || req.url === "/health" || req.url === "/_health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  // static
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let fsPath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  if (fsPath === "/" || fsPath === "") fsPath = "/index.html";
  const full = join(PUBLIC_DIR, fsPath);
  stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = extname(full).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    createReadStream(full).pipe(res);
  });
});

// --- WebSocket relay (your logic) ---
const wss = new WebSocketServer({ server: httpServer });

// In-memory game state
/** @type {Map<string, {x:number, z:number, name:string}>} */
const players = new Map();
/** @type {Map<WebSocket, string>} */
const socketToId = new Map();
/** @type {Map<string, number>} */
const scores = new Map();

function newId() { return (typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); }

function snapshot() {
  const playersObj = {};
  for (const [id, p] of players.entries()) playersObj[id] = { x: p.x, z: p.z, name: p.name || "Player" };
  const scoresObj = {};
  for (const [id, sc] of scores.entries()) scoresObj[id] = { name: players.get(id)?.name || "Player", score: sc | 0 };
  return { players: playersObj, scores: scoresObj };
}

function send(ws, t, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t, ...(payload ?? {}) }));
}
function broadcast(t, payload, exceptId = null) {
  const msg = JSON.stringify({ t, ...(payload ?? {}) });
  for (const [sock, id] of socketToId.entries()) {
    if (exceptId && id === exceptId) continue;
    if (sock.readyState === sock.OPEN) sock.send(msg);
  }
}
function bumpScore(id, delta = 1) { scores.set(id, (scores.get(id) || 0) + delta); }

wss.on("connection", (ws) => {
  const id = newId();
  socketToId.set(ws, id);

  send(ws, "hello", { id });
  send(ws, "snapshot", snapshot());

  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    const t = msg.t, p = msg.p || {};
    const me = socketToId.get(ws); if (!me) return;

    switch (t) {
      case "join": {
        const x = Number(p.x) || 0, z = Number(p.z) || 0;
        const name = (p.name || "Player").toString().slice(0, 20);
        players.set(me, { x, z, name });
        if (!scores.has(me)) scores.set(me, 0);
        broadcast("add", { id: me, p: { x, z, name } }, me);
        send(ws, "name", { id: me, p: { name } });
        break;
      }
      case "state": {
        const rec = players.get(me); if (!rec) break;
        rec.x = Number(p.x) || rec.x; rec.z = Number(p.z) || rec.z;
        broadcast("state", { id: me, p: { x: rec.x, z: rec.z } }, me);
        break;
      }
      case "name": {
        const name = (p.name || "Player").toString().slice(0, 20);
        const rec = players.get(me); if (rec) rec.name = name;
        broadcast("name", { id: me, p: { name } }, null);
        break;
      }
      case "pickup": {
        if (typeof p.idx === "number") broadcast("pickup", { id: me, id2: p.idx }, me);
        break;
      }
      case "shoot": {
        if (typeof p.idx === "number") broadcast("shoot", { id: me, p }, me);
        break;
      }
      case "land": {
        if (typeof p.idx === "number") broadcast("land", { p }, me);
        break;
      }
      case "score": {
        const scorer = (p.id && players.has(p.id)) ? p.id : me;
        bumpScore(scorer, 1);
        const name = players.get(scorer)?.name || "Player";
        broadcast("score", { id: scorer, p: { name, idx: p.idx } }, null);
        break;
      }
      case "reset": {
        scores.clear();
        for (const pid of players.keys()) scores.set(pid, 0);
        broadcast("reset", {}, null);
        break;
      }
      default: break;
    }
  });

  ws.on("close", () => {
    const id = socketToId.get(ws);
    socketToId.delete(ws);
    if (id && players.has(id)) {
      players.delete(id);
      scores.delete(id);
      broadcast("remove", { id }, null);
    }
  });

  // keepalive
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

const interval = setInterval(() => {
  for (const ws of wss.clients) {
    // @ts-ignore
    if (ws.isAlive === false) { ws.terminate(); continue; }
    // @ts-ignore
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(interval));

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS listening on :${PORT}`);
});