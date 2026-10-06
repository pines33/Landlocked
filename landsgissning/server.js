'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 30 * 60 * 1000;      // rum utan aktivitet raderas efter 30 min
const ROOM_EMPTY_MS = 10 * 60 * 1000;     // rum där ingen är ansluten raderas efter 10 min
const HEARTBEAT_MS = 25 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // utan 0/O, 1/I
const MAX_CHAT = 300;
const MAX_NAME = 20;

// ---------- Landslista: samma koder som kartan använder ----------
const MAP_FILE = require.resolve('jsvectormap/dist/maps/world.js');
const COUNTRIES = new Set(
  [...fs.readFileSync(MAP_FILE, 'utf8').matchAll(/[{,]([A-Z]{2}):\{path:/g)].map((m) => m[1])
);
if (COUNTRIES.size < 100) throw new Error('Kunde inte läsa landskoder från kartfilen');

// ---------- Rum ----------
/**
 * room = {
 *   code, phase: 'lobby'|'picking'|'playing'|'over', round, starter, turn, winner,
 *   players: [player|null, player|null], guesses: [{seat,country,correct}], chat: [], lastActivity
 * }
 * player = { token, name, pick, ws, connected, rematch, disconnectedAt }
 */
const rooms = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function newPlayer(name) {
  return {
    token: crypto.randomBytes(16).toString('hex'),
    name: cleanName(name),
    pick: null,
    ws: null,
    connected: false,
    rematch: false,
  };
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return n || 'Spelare';
}

function touch(room) {
  room.lastActivity = Date.now();
}

/** Bygger ett tillstånd specifikt för en spelare – motståndarens land skickas bara när spelet är slut. */
function viewFor(room, seat) {
  const me = room.players[seat];
  const op = room.players[1 - seat];
  const over = room.phase === 'over';
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    round: room.round,
    seat,
    turn: room.turn,
    winner: room.winner,
    guesses: room.guesses,
    you: { name: me.name, pick: me.pick, rematch: me.rematch },
    opp: op
      ? {
          name: op.name,
          connected: op.connected,
          hasPicked: !!op.pick,
          rematch: op.rematch,
          pick: over ? op.pick : null,
        }
      : null,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(room) {
  room.players.forEach((p, seat) => p && send(p.ws, viewFor(room, seat)));
}

function broadcast(room, msg) {
  room.players.forEach((p) => p && send(p.ws, msg));
}

function attach(room, seat, ws) {
  const p = room.players[seat];
  if (p.ws && p.ws !== ws) {
    send(p.ws, { t: 'kicked', msg: 'Rummet öppnades i en annan flik eller enhet.' });
    p.ws.__room = null;
    p.ws.close();
  }
  p.ws = ws;
  p.connected = true;
  p.disconnectedAt = null;
  ws.__room = room.code;
  ws.__seat = seat;
  send(ws, { t: 'session', code: room.code, token: p.token, seat });
  send(ws, { t: 'chatLog', messages: room.chat });
}

function startRound(room) {
  room.phase = 'picking';
  room.round += 1;
  room.turn = null;
  room.winner = null;
  room.guesses = [];
  room.players.forEach((p) => { p.pick = null; p.rematch = false; });
}

function pushChat(room, m) {
  m.ts = Date.now();
  room.chat.push(m);
  if (room.chat.length > 100) room.chat.shift();
  broadcast(room, { t: 'chat', message: m });
}

// ---------- Meddelandehantering ----------
const handlers = {
  create(ws, msg) {
    const room = {
      code: newCode(),
      phase: 'lobby',
      round: 0,
      starter: crypto.randomInt(2),
      turn: null,
      winner: null,
      players: [newPlayer(msg.name), null],
      guesses: [],
      chat: [],
      lastActivity: Date.now(),
    };
    rooms.set(room.code, room);
    attach(room, 0, ws);
    broadcastState(room);
  },

  join(ws, msg) {
    const room = rooms.get(String(msg.code || '').toUpperCase().trim());
    if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'Hittade inget rum med den koden.' });
    if (room.players[1]) return send(ws, { t: 'error', code: 'full', msg: 'Rummet är redan fullt.' });
    room.players[1] = newPlayer(msg.name);
    attach(room, 1, ws);
    startRound(room);
    touch(room);
    broadcastState(room);
  },

  resume(ws, msg) {
    const room = rooms.get(String(msg.code || '').toUpperCase());
    const seat = room ? room.players.findIndex((p) => p && p.token === msg.token) : -1;
    if (seat < 0) return send(ws, { t: 'error', code: 'nosession', msg: 'Rummet finns inte längre.' });
    attach(room, seat, ws);
    touch(room);
    broadcastState(room);
  },

  pick(ws, msg, room, seat) {
    if (room.phase !== 'picking') return;
    if (!COUNTRIES.has(msg.country)) return send(ws, { t: 'error', msg: 'Ogiltigt land.' });
    room.players[seat].pick = msg.country;
    if (room.players.every((p) => p && p.pick)) {
      room.phase = 'playing';
      room.turn = room.starter;
      room.starter = 1 - room.starter; // nästa omgång börjar den andra
    }
    broadcastState(room);
  },

  guess(ws, msg, room, seat) {
    if (room.phase !== 'playing' || room.turn !== seat) return send(ws, { t: 'error', msg: 'Det är inte din tur.' });
    if (!COUNTRIES.has(msg.country)) return send(ws, { t: 'error', msg: 'Ogiltigt land.' });
    const correct = room.players[1 - seat].pick === msg.country;
    room.guesses.push({ seat, country: msg.country, correct });
    pushChat(room, { kind: 'guess', seat, name: room.players[seat].name, country: msg.country, correct });
    if (correct) {
      room.phase = 'over';
      room.winner = seat;
      room.turn = null;
    } else {
      room.turn = 1 - seat;
    }
    broadcastState(room);
  },

  endTurn(ws, msg, room, seat) {
    if (room.phase !== 'playing' || room.turn !== seat) return;
    room.turn = 1 - seat;
    broadcastState(room);
  },

  chat(ws, msg, room, seat) {
    const text = String(msg.text || '').trim().slice(0, MAX_CHAT);
    if (!text) return;
    pushChat(room, { kind: 'text', seat, name: room.players[seat].name, text });
  },

  rematch(ws, msg, room, seat) {
    if (room.phase !== 'over') return;
    room.players[seat].rematch = true;
    if (room.players.every((p) => p && p.rematch)) startRound(room);
    broadcastState(room);
  },

  leave(ws, msg, room, seat) {
    const p = room.players[seat];
    p.ws = null;
    p.connected = false;
    ws.__room = null;
    const other = room.players[1 - seat];
    if (other) send(other.ws, { t: 'oppLeft' });
    rooms.delete(room.code);
  },
};

const ROOM_LESS = new Set(['create', 'join', 'resume']);

function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.t !== 'string' || !Object.hasOwn(handlers, msg.t)) return;
  if (ROOM_LESS.has(msg.t)) {
    if (ws.__room) detach(ws); // byter rum på samma anslutning
    return handlers[msg.t](ws, msg);
  }
  const room = rooms.get(ws.__room);
  if (!room || room.players[ws.__seat]?.ws !== ws) {
    return send(ws, { t: 'error', code: 'nosession', msg: 'Rummet finns inte längre.' });
  }
  touch(room);
  handlers[msg.t](ws, msg, room, ws.__seat);
}

function detach(ws) {
  const room = rooms.get(ws.__room);
  ws.__room = null;
  if (!room) return;
  const p = room.players[ws.__seat];
  if (p && p.ws === ws) {
    p.ws = null;
    p.connected = false;
    p.disconnectedAt = Date.now();
    broadcastState(room);
  }
}

// ---------- HTTP + WebSocket ----------
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/countries.json', (req, res) => res.json([...COUNTRIES]));
app.use('/vendor/jsvectormap', express.static(path.dirname(require.resolve('jsvectormap/dist/jsvectormap.min.js'))));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => onMessage(ws, data.toString()));
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// Håller anslutningar vid liv (proxyer på Render/Railway stänger tysta sockets) och städar gamla rum.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    const players = room.players.filter(Boolean);
    const allGone = players.every((p) => !p.connected && now - (p.disconnectedAt || 0) > ROOM_EMPTY_MS);
    if (now - room.lastActivity > ROOM_IDLE_MS || allGone) {
      players.forEach((p) => p.ws && send(p.ws, { t: 'error', code: 'nosession', msg: 'Rummet stängdes på grund av inaktivitet.' }));
      rooms.delete(code);
    }
  }
}, HEARTBEAT_MS).unref();

server.listen(PORT, () => {
  console.log(`Landsgissning körs på http://localhost:${PORT} (${COUNTRIES.size} länder)`);
});

module.exports = { server, rooms };
