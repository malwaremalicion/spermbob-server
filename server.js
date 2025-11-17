// server.js
// Node WebSocket server — server authoritative buy (Buy Style 2), spawns walkers and broadcasts spawn/remove events.
// npm install ws
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log('WebSocket server starting on port', PORT);

const ROOMS = {}; // roomCode -> { players: {id: {username, collection, money, ws}}, walkers: Map<id,walker>, walkerInterval }

const WALKER_SPAWN_INTERVAL = 1000; // 1s
const WALKER_LIFETIME = 10000; // 10s before auto-removed
const STEAL_TIMEOUT = 15000; // 15s

function makeWalker() {
  const rarities = [
    { id: 'Common', costFactor: 1, tintIndex: 0 },
    { id: 'Uncommon', costFactor: 2, tintIndex: 1 },
    { id: 'Rare', costFactor: 4, tintIndex: 2 },
    { id: 'Epic', costFactor: 8, tintIndex: 3 },
  ];
  const r = rarities[Math.floor(Math.random() * rarities.length)];
  const type = Math.random() < 0.5 ? 'spermbob' : 'bellbob';
  const id = 'w' + Date.now().toString(36) + Math.floor(Math.random()*999);
  const cost = 10 * r.costFactor + Math.floor(Math.random() * (5 * r.costFactor));
  const mps = Math.max(1, Math.floor(cost / 10));
  return { id, type, rarity: r.id, cost, mps };
}

function broadcastRoom(roomCode, extra = null) {
  const room = ROOMS[roomCode];
  if (!room) return;
  const playersPayload = {};
  for (const id in room.players) {
    const p = room.players[id];
    playersPayload[id] = {
      username: p.username,
      collection: p.collection,
      money: p.money
    };
  }
  // walkers: send array of walkers currently available (for clients that join late)
  const walkersArr = Array.from(room.walkers.values()).map(w => ({
    id: w.id, type: w.type, rarity: w.rarity, cost: w.cost, mps: w.mps
  }));
  const payload = { type: 'roomUpdate', players: playersPayload, walkers: walkersArr };
  if (extra) Object.assign(payload, extra);
  for (const id in room.players) {
    try { room.players[id].ws.send(JSON.stringify(payload)); } catch (e) {}
  }
}

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).slice(2,9);
  ws.room = null;
  ws.activeSteals = {}; // key victim_slot -> { thiefId, timeout }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }
    // JOIN ROOM
    if (msg.type === 'joinRoom') {
      const roomCode = msg.roomCode || 'lobby';
      ws.room = roomCode;
      if (!ROOMS[roomCode]) {
        ROOMS[roomCode] = { players: {}, walkers: new Map(), walkerInterval: null };
      }
      const room = ROOMS[roomCode];
      room.players[ws.id] = {
        username: msg.username || ('player' + Math.floor(Math.random()*9999)),
        collection: Array(8).fill(null),
        money: (typeof msg.money === 'number') ? msg.money : 30,
        ws
      };
      // spawn loop for this room
      if (!room.walkerInterval) {
        room.walkerInterval = setInterval(() => {
          const w = makeWalker();
          room.walkers.set(w.id, w);
          // broadcast single spawn event
          for (const id in room.players) {
            try { room.players[id].ws.send(JSON.stringify({ type: 'walkerSpawn', walker: w })); } catch(e) {}
          }
          // auto-remove after lifetime (unless bought)
          setTimeout(() => {
            if (room.walkers.has(w.id)) {
              room.walkers.delete(w.id);
              for (const id in room.players) {
                try { room.players[id].ws.send(JSON.stringify({ type: 'walkerRemove', id: w.id })); } catch(e) {}
              }
            }
          }, WALKER_LIFETIME);
        }, WALKER_SPAWN_INTERVAL);
      }
      // broadcast updated state (players + current walkers snapshot)
      broadcastRoom(roomCode);
      return;
    }

    // Must be in a room for further messages
    if (!ws.room || !ROOMS[ws.room]) return;
    const room = ROOMS[ws.room];

    // BUY REQUEST (server-authoritative)
    if (msg.type === 'buyRequest' && msg.itemId) {
      const buyer = room.players[ws.id];
      const walker = room.walkers.get(msg.itemId);
      if (!buyer || !walker) {
        try { ws.send(JSON.stringify({ type: 'buyResult', success:false, reason:'invalid' })); } catch(e) {}
        return;
      }
      // check money and free slot
      if (buyer.money < walker.cost) {
        try { ws.send(JSON.stringify({ type:'buyResult', success:false, reason:'no_money' })); } catch(e) {}
        return;
      }
      const slot = buyer.collection.findIndex(s => !s);
      if (slot === -1) {
        try { ws.send(JSON.stringify({ type:'buyResult', success:false, reason:'no_slot' })); } catch(e) {}
        return;
      }
      // perform buy: deduct cost, assign item copy into slot, remove walker
      buyer.money -= walker.cost;
      // store shallow copy (so later server-side sell/steal uses same fields)
      buyer.collection[slot] = { id: walker.id, type: walker.type, rarity: walker.rarity, cost: walker.cost, mps: walker.mps };
      room.walkers.delete(walker.id);
      // notify buyer with success
      try { ws.send(JSON.stringify({ type:'buyResult', success:true, slot, item: buyer.collection[slot] })); } catch(e) {}
      // notify all clients to remove walker and update players
      for (const id in room.players) {
        try { room.players[id].ws.send(JSON.stringify({ type:'walkerRemove', id: walker.id })); } catch(e) {}
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
      if (ws.activeSteals[key]) return; // already stealing same
      // broadcast start to let clients show progress UI
      for (const id in room.players) {
        try { room.players[id].ws.send(JSON.stringify({ type:'stealStart', thiefId: ws.id, victimId: msg.victimId, slot: msg.slot })); } catch(e) {}
      }
      // server-side timeout to complete steal
      const timeout = setTimeout(() => {
        const thief = room.players[ws.id];
        const victimNow = room.players[msg.victimId];
        if (!thief || !victimNow) return;
        const item = victimNow.collection[msg.slot];
        if (!item) { delete ws.activeSteals[key]; return; }
        const free = thief.collection.findIndex(c => !c);
        if (free === -1) { delete ws.activeSteals[key]; return; }
        thief.collection[free] = item;
        victimNow.collection[msg.slot] = null;
        // notify room of steal success
        for (const id in room.players) {
          try { room.players[id].ws.send(JSON.stringify({ type:'stealSuccess', thiefId: ws.id, victimId: msg.victimId, slot: msg.slot })); } catch(e) {}
        }
        broadcastRoom(ws.room);
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);
      ws.activeSteals[key] = { thiefId: ws.id, timeout };
      return;
    }

    // STEAL BLOCK
    if (msg.type === 'stealBlocked' && msg.victimId && typeof msg.slot === 'number') {
      // find any active steals in server side where the thief is trying to steal victimId_slot
      const key = `${msg.victimId}_${msg.slot}`;
      // iterate over all clients to find the thief who has that active steal
      for (const client of wss.clients) {
        if (client.activeSteals && client.activeSteals[key]) {
          clearTimeout(client.activeSteals[key].timeout);
          delete client.activeSteals[key];
          // broadcast block
          for (const id in room.players) {
            try { room.players[id].ws.send(JSON.stringify({ type:'stealBlocked', thiefId: client.id, victimId: msg.victimId, slot: msg.slot })); } catch(e) {}
          }
        }
      }
      return;
    }
  }); // end message

  ws.on('close', () => {
    if (!ws.room) return;
    const room = ROOMS[ws.room];
    if (!room) return;
    if (room.players[ws.id]) delete room.players[ws.id];
    // clean up room if empty
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.walkerInterval);
      delete ROOMS[ws.room];
    } else {
      broadcastRoom(ws.room);
    }
  });
});

console.log('Server ready');
