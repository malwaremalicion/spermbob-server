// server.js
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });

console.log(`WebSocket server running on 0.0.0.0:${PORT}`);

const rooms = {}; // roomCode => { players: {id: {username, collection, money, ws}}, walkers: [] }
const STEAL_TIMEOUT = 15000;

// Example walker pool
const WALKER_POOL = [
  { id: 'w1', type: 'bellbob', cost: 10, mps: 1, rarity: 'common' },
  { id: 'w2', type: 'spermbob', cost: 20, mps: 2, rarity: 'rare' }
];

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).substr(2, 9);
  ws.room = null;
  ws.activeSteals = {};

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }

    // JOIN ROOM
    if (data.type === 'joinRoom') {
      const code = data.roomCode || 'lobby';
      ws.room = code;
      if (!rooms[code]) rooms[code] = { players: {}, walkers: [] };

      // Add player
      rooms[code].players[ws.id] = {
        username: data.username || ('player' + Math.floor(Math.random() * 9999)),
        collection: Array(8).fill(null),
        money: data.money ?? 30,
        ws
      };

      // spawn walkers for this room only once
      if (rooms[code].walkers.length === 0) {
        rooms[code].walkers = WALKER_POOL.map(w => ({ ...w }));
      }

      broadcastRoom(code);
      return;
    }

    if (!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // BUY
    if (data.type === 'buy' && data.slot !== undefined && data.itemId) {
      const freeSlot = data.slot;
      const player = room.players[ws.id];
      const walker = room.walkers.find(w => w.id === data.itemId);
      if (!walker || !player || player.money < walker.cost) return;

      player.collection[freeSlot] = { ...walker }; // assign full walker info
      player.money -= walker.cost;

      // remove walker from room
      room.walkers = room.walkers.filter(w => w.id !== data.itemId);

      broadcastRoom(ws.room);
      return;
    }

    // SELL
    if (data.type === 'sell' && data.slot !== undefined) {
      const player = room.players[ws.id];
      const item = player.collection[data.slot];
      if (item) {
        player.money += Math.floor((item.mps || 0) * 5);
        player.collection[data.slot] = null;
        broadcastRoom(ws.room);
      }
      return;
    }

    // UPDATE COLLECTION/MONEY
    if (data.type === 'update') {
      const player = room.players[ws.id];
      if (!player) return;
      if (data.collection) player.collection = data.collection;
      if (data.money !== undefined) player.money = data.money;
      broadcastRoom(ws.room);
      return;
    }

    // START STEAL
    if (data.type === 'stealStart' && data.victimId !== undefined && data.slot !== undefined) {
      const victim = room.players[data.victimId];
      if (!victim) return;
      const key = `${data.victimId}_${data.slot}`;
      if (ws.activeSteals[key]) return;

      broadcastRoom(ws.room, { type: 'stealStart', thiefId: ws.id, victimId: data.victimId, slot: data.slot });

      const timeout = setTimeout(() => {
        const victimPlayer = room.players[data.victimId];
        const thiefPlayer = room.players[ws.id];
        if (victimPlayer && thiefPlayer) {
          const item = victimPlayer.collection[data.slot];
          if (item) {
            const freeIndex = thiefPlayer.collection.findIndex(c => !c);
            if (freeIndex !== -1) {
              thiefPlayer.collection[freeIndex] = item;
              victimPlayer.collection[data.slot] = null;
            }
          }
          broadcastRoom(ws.room, { type: 'stealSuccess', thiefId: ws.id, victimId: data.victimId, slot: data.slot });
          broadcastRoom(ws.room);
        }
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);

      ws.activeSteals[key] = { thiefId: ws.id, timeout };
      return;
    }

    // BLOCK STEAL
    if (data.type === 'stealBlocked' && data.victimId !== undefined && data.slot !== undefined) {
      const key = `${data.victimId}_${data.slot}`;
      const steal = ws.activeSteals[key];
      if (steal) {
        clearTimeout(steal.timeout);
        delete ws.activeSteals[key];
        broadcastRoom(ws.room, { type: 'stealBlocked', thiefId: steal.thiefId, victimId: data.victimId, slot: data.slot });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms[ws.room] && rooms[ws.room].players[ws.id]) {
      delete rooms[ws.room].players[ws.id];
      if (Object.keys(rooms[ws.room].players).length === 0) delete rooms[ws.room];
      else broadcastRoom(ws.room);
    }
  });
});

function broadcastRoom(code, extra = null) {
  const room = rooms[code];
  if (!room) return;
  const payload = { type: 'roomUpdate', players: {}, walkers: room.walkers };
  for (const id in room.players) {
    const p = room.players[id];
    payload.players[id] = {
      username: p.username,
      collection: p.collection,
      money: p.money
    };
  }
  if (extra) Object.assign(payload, extra);

  for (const id in room.players) {
    const p = room.players[id];
    try { p.ws.send(JSON.stringify(payload)); } catch (e) { }
  }
}


