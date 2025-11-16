// server.js
// Node.js WebSocket server for "Steal A Spermbob"
// - Walkers are server-generated (spawned per-room)
// - Walkers are normal items and placed in player's collection when bought
// - Server ticks money per-player using collection MPS (money per second)
// - Steal/sell/buy handled server-side (authoritative)
// - No anti-cheat (per your request)

const WebSocket = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server running on ws://localhost:${PORT} (or your host wss URL)`);

// Config
const STEAL_TIMEOUT = 15000;        // ms before steal completes
const WALKER_SPAWN_MS = 2500;       // per-room walker spawn interval
const WALKER_LIFETIME_MS = 30000;   // how long a walker stays alive if not bought
const MONEY_TICK_MS = 1000;         // server money tick frequency

// Data: rooms[roomCode] = { players: {id: {username,collection,money,ws}}, walkers: {}, timers: {spawnTimer, moneyTimer} }
const rooms = {};

// Helpers
function makeId(len = 8){ return Math.random().toString(36).slice(2,2+len); }

function spawnWalkerInRoom(roomCode){
  const room = rooms[roomCode];
  if(!room) return;
  const rarities = [
    {name:'Common', cost:10, mps:1},
    {name:'Uncommon', cost:25, mps:3},
    {name:'Rare', cost:60, mps:7},
    {name:'Epic', cost:150, mps:15}
  ];
  const types = ['spermbob','bellbob'];
  const type = types[Math.floor(Math.random()*types.length)];
  const rar = rarities[Math.floor(Math.random()*rarities.length)];
  const walker = {
    id: makeId(10),
    type,
    rarity: rar.name,
    cost: rar.cost,
    mps: rar.mps,
    createdAt: Date.now(),
    expiresAt: Date.now() + WALKER_LIFETIME_MS
  };
  room.walkers[walker.id] = walker;
  // broadcast the spawn immediately (roomUpdate will include walkers)
  broadcastRoom(roomCode, { type:'walkerSpawn', walker });
  return walker;
}

function broadcastRoom(roomCode, extra = null){
  const room = rooms[roomCode];
  if(!room) return;
  const base = { type:'roomUpdate', players:{}, walkers: [] };

  // players: include username, collection, money
  for(const id in room.players){
    const p = room.players[id];
    base.players[id] = {
      username: p.username,
      collection: p.collection,
      money: p.money
    };
  }

  // walkers list
  base.walkers = Object.values(room.walkers || {});

  // send personalized payload to each client with 'you' property
  for(const id in room.players){
    const p = room.players[id];
    const payload = Object.assign({}, base);
    if(extra) Object.assign(payload, extra);
    payload.you = id;
    try { p.ws.send(JSON.stringify(payload)); } catch(e){ /* ignore send errors */ }
  }
}

// Remove expired walkers periodically for each room
function cleanupExpiredWalkersInRoom(roomCode){
  const room = rooms[roomCode];
  if(!room) return;
  const now = Date.now();
  let removed = false;
  for(const id in room.walkers){
    if(room.walkers[id].expiresAt <= now){
      delete room.walkers[id];
      removed = true;
    }
  }
  if(removed) broadcastRoom(roomCode);
}

// Ensure room timers exist when room first created
function ensureRoomTimers(roomCode){
  const room = rooms[roomCode];
  if(!room) return;
  if(room.timersStarted) return;
  // spawn walkers
  room.spawnTimer = setInterval(()=> spawnWalkerInRoom(roomCode), WALKER_SPAWN_MS);
  // cleanup expired walkers (and broadcast if needed)
  room.cleanupTimer = setInterval(()=> cleanupExpiredWalkersInRoom(roomCode), 3000);
  // money tick: add money from collection MPS
  room.moneyTimer = setInterval(()=> {
    for(const id in room.players){
      const pl = room.players[id];
      if(!pl) continue;
      let inc = 0;
      for(const s of pl.collection){
        if(s && s.mps) inc += Number(s.mps);
      }
      if(inc > 0){
        pl.money = (pl.money || 0) + inc;
      }
    }
    broadcastRoom(roomCode);
  }, MONEY_TICK_MS);
  room.timersStarted = true;
}

// Cleanup room timers when empty
function maybeStopRoomTimers(roomCode){
  const room = rooms[roomCode];
  if(!room) return;
  if(Object.keys(room.players).length === 0){
    if(room.spawnTimer) { clearInterval(room.spawnTimer); room.spawnTimer = null; }
    if(room.cleanupTimer) { clearInterval(room.cleanupTimer); room.cleanupTimer = null; }
    if(room.moneyTimer) { clearInterval(room.moneyTimer); room.moneyTimer = null; }
    room.timersStarted = false;
  }
}

/* WebSocket connection */
wss.on('connection', ws => {
  ws.id = makeId(9);
  ws.room = null;
  ws.activeSteals = {}; // key victim_slot -> { thiefId, timeout }

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e){ return; }

    // joinRoom
    if(data.type === 'joinRoom'){
      const code = String(data.roomCode || 'lobby');
      ws.room = code;
      if(!rooms[code]) {
        rooms[code] = { players: {}, walkers: {}, timersStarted:false };
      }
      const room = rooms[code];
      // add player record
      room.players[ws.id] = {
        username: String(data.username || 'player'),
        collection: Array(8).fill(null),
        money: Number(data.money ?? 30),
        ws
      };
      // start timers for room (walker spawn, money tick)
      ensureRoomTimers(code);
      // broadcast updated room
      broadcastRoom(code);
      return;
    }

    // ignore messages if not in a room
    if(!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // update (client -> server). NOTE: server is authoritative for money.
    if(data.type === 'update'){
      if(data.collection && Array.isArray(data.collection)){
        // adopt client's collection as-is (user requested to keep this behavior)
        room.players[ws.id].collection = data.collection;
      }
      // Ignore client-sent money to avoid clients directly setting their money.
      // (You asked for no anti-cheat, but we're still making server authoritative on money ticks and buys)
      broadcastRoom(ws.room);
      return;
    }

    // buy (authoritative)
    if(data.type === 'buy' && data.slot !== undefined && data.item){
      const buyer = room.players[ws.id];
      if(!buyer) return;
      const slot = Number(data.slot);
      const item = data.item;
      const cost = Number(item.cost) || 0;

      // validations
      if(slot < 0 || slot >= buyer.collection.length) return;
      if(buyer.collection[slot] !== null) return; // occupied
      if(buyer.money === undefined) buyer.money = 0;
      if(buyer.money < cost) {
        // insufficient funds -> reject (could send an error event)
        try{ ws.send(JSON.stringify({ type:'error', message:'insufficient_funds' })); }catch(e){}
        return;
      }

      // apply buy
      buyer.collection[slot] = {
        type: item.type,
        rarity: item.rarity,
        mps: Number(item.mps) || 0,
        cost: cost
      };
      buyer.money -= cost;

      // remove walker from room if itemId provided
      if(data.itemId && room.walkers[data.itemId]) delete room.walkers[data.itemId];

      // notify others a buy happened, then broadcast full room state
      broadcastRoom(ws.room, { type:'buy', buyerId: ws.id, slot, itemId: data.itemId });
      broadcastRoom(ws.room);
      return;
    }

    // sell
    if(data.type === 'sell' && data.slot !== undefined){
      const pl = room.players[ws.id];
      if(!pl) return;
      const slot = Number(data.slot);
      const item = pl.collection[slot];
      if(!item) return;
      // refund formula: mps * 5 (same as previous)
      const refund = Math.max(1, Math.floor((item.mps||0) * 5));
      pl.money = (pl.money || 0) + refund;
      pl.collection[slot] = null;
      broadcastRoom(ws.room, { type:'sell', sellerId: ws.id, slot });
      broadcastRoom(ws.room);
      return;
    }

    // start steal
    if(data.type === 'stealStart' && data.victimId !== undefined && data.slot !== undefined){
      const victimId = data.victimId;
      const slot = Number(data.slot);
      const victim = room.players[victimId];
      if(!victim) return;
      const key = `${victimId}_${slot}`;
      if(ws.activeSteals[key]) return; // already stealing

      // inform clients steal started
      broadcastRoom(ws.room, { type:'stealStart', thiefId: ws.id, victimId, slot });

      // schedule steal complete
      const timeout = setTimeout(()=>{
        // re-check existence
        const victimPlayer = room.players[victimId];
        const thiefPlayer = room.players[ws.id];
        if(victimPlayer && thiefPlayer){
          const stolenItem = victimPlayer.collection[slot];
          if(stolenItem){
            const freeIndex = thiefPlayer.collection.findIndex(c => !c);
            if(freeIndex !== -1){
              // transfer
              thiefPlayer.collection[freeIndex] = stolenItem;
              victimPlayer.collection[slot] = null;
              // notify steal success and broadcast full room
              broadcastRoom(ws.room, { type:'stealSuccess', thiefId: ws.id, victimId, slot });
            } else {
              // thief had no space -> steal fails (we will just not transfer)
              broadcastRoom(ws.room, { type:'stealFail', reason: 'no_space', thiefId: ws.id, victimId, slot });
            }
            broadcastRoom(ws.room);
          }
        }
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);

      ws.activeSteals[key] = { thiefId: ws.id, timeout };
      return;
    }

    // steal blocked (victim blocks)
    if(data.type === 'stealBlocked' && data.victimId !== undefined && data.slot !== undefined){
      const key = `${data.victimId}_${data.slot}`;
      // find which client started that steal: iterate clients in room
      for(const cid in room.players){
        const client = room.players[cid].ws;
        if(client && client.activeSteals && client.activeSteals[key]){
          const steal = client.activeSteals[key];
          clearTimeout(steal.timeout);
          delete client.activeSteals[key];
          // notify all
          broadcastRoom(ws.room, { type:'stealBlocked', thiefId: steal.thiefId, victimId: data.victimId, slot: data.slot });
          break;
        }
      }
      return;
    }

    // other message types -> ignore
  });

  ws.on('close', ()=>{
    // remove player from room
    if(ws.room && rooms[ws.room] && rooms[ws.room].players[ws.id]){
      delete rooms[ws.room].players[ws.id];
      // if room empty, delete and stop timers
      if(Object.keys(rooms[ws.room].players).length === 0){
        // clear timers if any
        const r = rooms[ws.room];
        if(r.spawnTimer) clearInterval(r.spawnTimer);
        if(r.cleanupTimer) clearInterval(r.cleanupTimer);
        if(r.moneyTimer) clearInterval(r.moneyTimer);
        delete rooms[ws.room];
      } else {
        broadcastRoom(ws.room);
        maybeStopRoomTimers(ws.room);
      }
    }
  });
});

/* Graceful shutdown helpers (optional) */
process.on('SIGINT', ()=> {
  console.log('Shutting down...');
  wss.close(()=> process.exit(0));
});
