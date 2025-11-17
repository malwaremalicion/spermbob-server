// server.js — Spermbob WebSocket server
// Features: room-based, walker spawn, server-authoritative buy/sell/steal, MPS tick
// Install: npm init -y && npm i ws
// Run: node server.js  (on Railway/set PORT via env)

const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log('Spermbob server starting on port', PORT);

/* Config */
const WALKER_SPAWN_INTERVAL = 1000;   // spawn every 1s
const WALKER_LIFETIME = 10000;        // 10s lifetime if not bought
const STEAL_TIMEOUT = 15000;          // 15s to complete steal
const MPS_TICK_INTERVAL = 1000;       // server awards mps once per second
const COLLECTION_SLOTS = 8;

const ROOMS = {}; // roomCode -> { players: {id:{username,collection,money,ws}}, walkers: Map, walkerInterval }

/* utilities */
function makeWalker() {
  const rarityTable = [
  { name: "common", chance: 0.70, tint: "#ffffff", baseCost: 5, baseMps: 1 },
  { name: "rare", chance: 0.20, tint: "#3b82f6", baseCost: 20, baseMps: 4 },
  { name: "epic", chance: 0.08, tint: "#a855f7", baseCost: 60, baseMps: 10 },
  { name: "legendary", chance: 0.01, tint: "#fbbf24", baseCost: 150, baseMps: 25 },

  // ⭐ NEW SUPER-RARITY
  { name: "spermbob_god", chance: 0.005, tint: "#ff0000", baseCost: 400, baseMps: 60 }
];
  ];
  const r = rarities[Math.floor(Math.random() * rarities.length)];
  const type = Math.random() < 0.5 ? 'spermbob' : 'bellbob';
  const id = 'w' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100);
  const base = 10 * r.costFactor;
  const cost = base + Math.floor(Math.random() * (5 * r.costFactor + 1));
  const mps = Math.max(1, Math.floor(cost / 10));
  return { id, type, rarity: r.id, cost, mps };
}

function broadcastRoom(roomCode, extra = null) {
  const room = ROOMS[roomCode];
  if (!room) return;
  const playersPayload = {};
  for (const id in room.players) {
    const p = room.players[id];
    playersPayload[id] = { username: p.username, collection: p.collection, money: p.money };
  }
  const walkersArr = Array.from(room.walkers.values()).map(w => ({ id: w.id, type: w.type, rarity: w.rarity, cost: w.cost, mps: w.mps }));
  for (const id in room.players) {
    const p = room.players[id];
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      const payload = { type: 'roomUpdate', players: playersPayload, walkers: walkersArr, you: id };
      if (extra) Object.assign(payload, extra);
      try { p.ws.send(JSON.stringify(payload)); } catch (e) { /* ignore */ }
    }
  }
}

/* server authoritative MPS tick */
setInterval(() => {
  for (const roomCode in ROOMS) {
    const room = ROOMS[roomCode];
    let dirty = false;
    for (const id in room.players) {
      const p = room.players[id];
      let inc = 0;
      for (let i = 0; i < COLLECTION_SLOTS; i++) {
        const it = p.collection[i];
        if (it && it.mps) inc += it.mps;
      }
      if (inc > 0) { p.money += inc; dirty = true; }
    }
    if (dirty) broadcastRoom(roomCode);
  }
}, MPS_TICK_INTERVAL);

/* WebSocket handling */
wss.on('connection', ws => {
  ws.id = Math.random().toString(36).slice(2,9);
  ws.room = null;
  ws.activeSteals = {}; // key victim_slot -> { thiefId, timeout }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // JOIN ROOM
    if (msg.type === 'joinRoom') {
      const roomCode = msg.roomCode || 'lobby';
      ws.room = roomCode;
      if (!ROOMS[roomCode]) ROOMS[roomCode] = { players: {}, walkers: new Map(), walkerInterval: null };
      const room = ROOMS[roomCode];
      room.players[ws.id] = {
        username: msg.username || ('player' + Math.floor(Math.random()*9999)),
        collection: Array(COLLECTION_SLOTS).fill(null),
        money: (typeof msg.money === 'number') ? msg.money : 30,
        ws
      };
      // start walker spawns for room if needed
      if (!room.walkerInterval) {
        room.walkerInterval = setInterval(() => {
          const w = makeWalker();
          room.walkers.set(w.id, w);
          // notify clients about this spawn quickly
          for (const pid in room.players) {
            const p = room.players[pid];
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
              try { p.ws.send(JSON.stringify({ type: 'walkerSpawn', walker: w })); } catch(e) {}
            }
          }
          // schedule auto-remove
          setTimeout(() => {
            if (room && room.walkers && room.walkers.has(w.id)) {
              room.walkers.delete(w.id);
              for (const pid in room.players) {
                const p = room.players[pid];
                if (p.ws && p.ws.readyState === WebSocket.OPEN) {
                  try { p.ws.send(JSON.stringify({ type:'walkerRemove', id: w.id })); } catch(e) {}
                }
              }
            }
          }, WALKER_LIFETIME);
        }, WALKER_SPAWN_INTERVAL);
      }

      broadcastRoom(roomCode);
      return;
    }

    // must have a room for most actions
    if (!ws.room || !ROOMS[ws.room]) return;
    const room = ROOMS[ws.room];

    // client state update (collection or money)
    if (msg.type === 'update') {
      const me = room.players[ws.id];
      if (!me) return;
      if (Array.isArray(msg.collection)) me.collection = msg.collection;
      if (typeof msg.money === 'number') me.money = msg.money;
      broadcastRoom(ws.room);
      return;
    }

    // BUY request (server authoritative)
    if (msg.type === 'buyRequest' && msg.itemId) {
      const buyer = room.players[ws.id];
      const walker = room.walkers.get(msg.itemId);
      if (!buyer || !walker) { try { ws.send(JSON.stringify({ type:'buyResult', success:false, reason:'invalid' })); } catch(e){} return; }
      if (buyer.money < walker.cost) { try { ws.send(JSON.stringify({ type:'buyResult', success:false, reason:'no_money' })); } catch(e){} return; }
      const slot = buyer.collection.findIndex(s => !s);
      if (slot === -1) { try { ws.send(JSON.stringify({ type:'buyResult', success:false, reason:'no_slot' })); } catch(e){} return; }
      // perform buy
      buyer.money -= walker.cost;
      const itemCopy = { id: walker.id, type: walker.type, rarity: walker.rarity, cost: walker.cost, mps: walker.mps };
      buyer.collection[slot] = itemCopy;
      room.walkers.delete(walker.id);
      try { ws.send(JSON.stringify({ type:'buyResult', success:true, slot, item: itemCopy })); } catch(e){}
      // tell clients to remove walker quickly
      for (const pid in room.players) {
        const p = room.players[pid];
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
          try { p.ws.send(JSON.stringify({ type:'walkerRemove', id: walker.id })); } catch(e) {}
        }
      }
      broadcastRoom(ws.room);
      return;
    }

    // SELL
    if (msg.type === 'sell' && typeof msg.slot === 'number') {
      const p = room.players[ws.id];
      if (!p) return;
      const item = p.collection[msg.slot];
      if (!item) return;
      const refund = Math.max(1, Math.floor(item.mps * 5));
      p.money += refund;
      p.collection[msg.slot] = null;
      broadcastRoom(ws.room);
      return;
    }

    // STEAL START
    if (msg.type === 'stealStart' && msg.victimId && typeof msg.slot === 'number') {
      const victim = room.players[msg.victimId];
      if (!victim) return;
      const key = `${msg.victimId}_${msg.slot}`;
      if (ws.activeSteals[key]) return; // already started by same thief
      // broadcast start so UIs create popup / bars
      for (const pid in room.players) {
        const p = room.players[pid];
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
          try { p.ws.send(JSON.stringify({ type:'stealStart', thiefId: ws.id, victimId: msg.victimId, slot: msg.slot })); } catch(e) {}
        }
      }
      // schedule steal completion
      const timeout = setTimeout(() => {
        const thief = room.players[ws.id];
        const victimNow = room.players[msg.victimId];
        if (!thief || !victimNow) { delete ws.activeSteals[key]; return; }
        const item = victimNow.collection[msg.slot];
        if (!item) { delete ws.activeSteals[key]; return; }
        const free = thief.collection.findIndex(c => !c);
        if (free === -1) { delete ws.activeSteals[key]; return; }
        thief.collection[free] = item;
        victimNow.collection[msg.slot] = null;
        // notify outcome
        for (const pid in room.players) {
          const p = room.players[pid];
          if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            try { p.ws.send(JSON.stringify({ type:'stealSuccess', thiefId: ws.id, victimId: msg.victimId, slot: msg.slot })); } catch(e) {}
          }
        }
        broadcastRoom(ws.room);
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);
      ws.activeSteals[key] = { thiefId: ws.id, timeout };
      return;
    }

    // STEAL BLOCKED (victim blocked via popup click)
    if (msg.type === 'stealBlocked' && msg.victimId && typeof msg.slot === 'number') {
      const key = `${msg.victimId}_${msg.slot}`;
      // find client(s) that started the steal and clear
      wss.clients.forEach(client => {
        if (client.activeSteals && client.activeSteals[key]) {
          clearTimeout(client.activeSteals[key].timeout);
          delete client.activeSteals[key];
          for (const pid in room.players) {
            const p = room.players[pid];
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
              try { p.ws.send(JSON.stringify({ type:'stealBlocked', thiefId: client.id, victimId: msg.victimId, slot: msg.slot })); } catch(e) {}
            }
          }
        }
      });
      return;
    }

  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = ROOMS[ws.room];
    if (!room) return;
    if (room.players[ws.id]) delete room.players[ws.id];
    if (Object.keys(room.players).length === 0) {
      if (room.walkerInterval) clearInterval(room.walkerInterval);
      delete ROOMS[ws.room];
    } else {
      broadcastRoom(ws.room);
    }
  });

});

console.log('Spermbob server ready');


