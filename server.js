// server.js
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';

const PORT = process.env.PORT || 443;
const STEAL_TIMEOUT = 15000; // 15 seconds

const rooms = {};

const wss = new WebSocketServer({ port: PORT });
console.log(`WebSocket server running on port ${PORT}`);

wss.on('connection', ws => {
  let playerId = randomUUID();
  let roomCode = null;
  let activeSteals = {}; // key: victimId_slot -> { thiefId, timeout }

  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === 'joinRoom') {
        const rc = data.roomCode;
        const username = data.username || 'player';

        if (!rooms[rc]) rooms[rc] = { players: {} };
        roomCode = rc;
        rooms[rc].players[playerId] = {
          username,
          money: data.money ?? 30,
          collection: data.collection ?? Array(8).fill(null),
          ws
        };
        broadcastRoom(rc);
      }

      if (!roomCode) return;
      const player = rooms[roomCode].players[playerId];

      // Update money/collection
      if (data.type === 'update') {
        if (data.money !== undefined) player.money = data.money;
        if (data.collection) player.collection = data.collection;
        broadcastRoom(roomCode);
      }

      // Buy an item
      if (data.type === 'buy') {
        broadcastRoom(roomCode, { type: 'buy', itemId: data.item });
      }

      // Start a steal
      if (data.type === 'stealStart') {
        const victimId = data.victimId;
        const slot = data.slot;
        const victim = rooms[roomCode].players[victimId];
        if (!victim) return;

        const key = `${victimId}_${slot}`;
        if (activeSteals[key]) return; // already stealing

        broadcastRoom(roomCode, { type: 'stealStart', thiefId: playerId, victimId, slot });

        // start steal timeout
        const timeout = setTimeout(() => {
          const victimPlayer = rooms[roomCode]?.players[victimId];
          if (!victimPlayer) return;

          // transfer item if present
          const item = victimPlayer.collection[slot];
          if (item) {
            const thiefPlayer = rooms[roomCode].players[playerId];
            const freeIndex = thiefPlayer.collection.findIndex(c => !c);
            if (freeIndex !== -1) {
              thiefPlayer.collection[freeIndex] = item;
              victimPlayer.collection[slot] = null;
            }
          }

          broadcastRoom(roomCode, { type: 'stealSuccess', thiefId: playerId, victimId, slot });
          delete activeSteals[key];
          broadcastRoom(roomCode);
        }, STEAL_TIMEOUT);

        activeSteals[key] = { thiefId: playerId, timeout };
      }

      // Victim blocked steal
      if (data.type === 'stealBlocked') {
        const key = `${data.victimId}_${data.slot}`;
        const steal = activeSteals[key];
        if (steal) {
          clearTimeout(steal.timeout);
          delete activeSteals[key];
          broadcastRoom(roomCode, { type: 'stealBlocked', thiefId: steal.thiefId, victimId: data.victimId, slot: data.slot });
        }
      }

    } catch (e) {
      console.error('Error handling message', e);
    }
  });

  ws.on('close', () => {
    if (roomCode && rooms[roomCode]?.players[playerId]) {
      delete rooms[roomCode].players[playerId];

      // clear any active steals involving this player
      for (const key in activeSteals) {
        if (key.startsWith(playerId + '_') || key.includes(`_${playerId}`)) {
          clearTimeout(activeSteals[key].timeout);
          delete activeSteals[key];
        }
      }

      if (Object.keys(rooms[roomCode].players).length === 0) delete rooms[roomCode];
      else broadcastRoom(roomCode);
    }
  });

  // Send initial ID
  ws.send(JSON.stringify({ type: 'id', id: playerId }));
});

function broadcastRoom(rc, extra = null) {
  if (!rooms[rc]) return;
  const roomData = {
    type: 'roomUpdate',
    players: {},
    ...extra
  };
  for (const pid in rooms[rc].players) {
    const p = rooms[rc].players[pid];
    roomData.players[pid] = {
      username: p.username,
      money: p.money,
      collection: p.collection
    };
    roomData.you = pid; // each client will pick its own ID on receipt
  }

  for (const pid in rooms[rc].players) {
    const p = rooms[rc].players[pid];
    try { p.ws.send(JSON.stringify(roomData)); } catch (e) {}
  }
}
