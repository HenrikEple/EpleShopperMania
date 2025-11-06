// server.js
// Simple WebSocket game relay with names, scores, pickups, throws, resets.

import { createServer } from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 3001;

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

// ---- In-memory game state ----
/** @type {Map<string, {x:number, z:number, name:string}>} */
const players = new Map();
/** @type {Map<WebSocket, string>} */
const socketToId = new Map();
/** @type {Map<string, number>} */
const scores = new Map();

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function snapshot() {
  const playersObj = {};
  for (const [id, p] of players.entries()) playersObj[id] = { x: p.x, z: p.z, name: p.name || "Player" };
  const scoresObj = {};
  for (const [id, sc] of scores.entries()) scoresObj[id] = { name: players.get(id)?.name || "Player", score: sc|0 };
  return { players: playersObj, scores: scoresObj };
}

function send(ws, t, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ t, ...(payload ?? {}) }));
  }
}
function broadcast(t, payload, exceptId = null) {
  const msg = JSON.stringify({ t, ...(payload ?? {}) });
  for (const [sock, id] of socketToId.entries()) {
    if (exceptId && id === exceptId) continue;
    if (sock.readyState === sock.OPEN) sock.send(msg);
  }
}

function bumpScore(id, delta = 1) {
  scores.set(id, (scores.get(id) || 0) + delta);
}

// ---- Connection handling ----
wss.on("connection", (ws) => {
  const id = newId();
  socketToId.set(ws, id);

  // Hello + snapshot
  send(ws, "hello", { id });
  send(ws, "snapshot", snapshot());

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const t = msg.t;
    const p = msg.p || {};
    const me = socketToId.get(ws);
    if (!me) return;

    switch (t) {
      case "join": {
        const x = Number(p.x) || 0;
        const z = Number(p.z) || 0;
        const name = (p.name || "Player").toString().slice(0, 20);
        players.set(me, { x, z, name });
        if (!scores.has(me)) scores.set(me, 0);
        // announce
        broadcast("add", { id: me, p: { x, z, name } }, me);
        // echo back my name to ensure score table is initialized
        send(ws, "name", { id: me, p: { name } });
        break;
      }

      case "state": {
        const rec = players.get(me);
        if (!rec) break;
        rec.x = Number(p.x) || rec.x;
        rec.z = Number(p.z) || rec.z;
        broadcast("state", { id: me, p: { x: rec.x, z: rec.z } }, me);
        break;
      }

      case "name": {
        const name = (p.name || "Player").toString().slice(0, 20);
        const rec = players.get(me);
        if (rec) rec.name = name;
        broadcast("name", { id: me, p: { name } }, null);
        break;
      }

      case "pickup": {
        // p.idx (ball index) picked by me
        if (typeof p.idx === "number") {
          broadcast("pickup", { id: me, id2: p.idx }, me);
        }
        break;
      }

      case "shoot": {
        // p: { idx, x,y,z, vx,vy,vz }
        if (typeof p.idx === "number") {
          broadcast("shoot", { id: me, p }, me);
        }
        break;
      }

      case "land": {
        // ball settled to pickup again at x,z
        if (typeof p.idx === "number") {
          broadcast("land", { p }, me);
        }
        break;
      }

      case "score": {
        // client detected a score for shooter id (could be me)
        const scorer = (p.id && players.has(p.id)) ? p.id : me;
        bumpScore(scorer, 1);
        const name = players.get(scorer)?.name || "Player";
        broadcast("score", { id: scorer, p: { name } }, null);
        break;
      }

      case "reset": {
        // Reset scores and ask clients to reseed pickups
        scores.clear();
        for (const pid of players.keys()) scores.set(pid, 0);
        broadcast("reset", {}, null);
        break;
      }

      default:
        // ignore unknown
        break;
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

  // Basic keepalive to avoid idle timeouts on some hosts
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

// Keepalive sweep
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    // @ts-ignore
    if (ws.isAlive === false) return ws.terminate();
    // @ts-ignore
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(interval));

httpServer.listen(PORT, () => {
  console.log(`WS server listening on :${PORT}`);
});