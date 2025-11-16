// server.js
const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
const server = require('http').createServer();
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log("WebSocket server running on port " + PORT);
});

console.log(`WS server running on port ${PORT}`);

const STEAL_TIMEOUT = 15000;
const WALKER_SPAWN_MS = 2500;
const WALKER_LIFETIME_MS = 30000;
const MONEY_TICK_MS = 1000;

const rooms = {};

function makeId(len = 8){ return Math.random().toString(36).slice(2, 2+len); }

function ensureRoom(roomCode){
  if(!rooms[roomCode]) rooms[roomCode] = { players:{}, walkers:{}, timersStarted:false };
  const room = rooms[roomCode];
  if(room.timersStarted) return room;
  // spawn walkers
  room.spawnTimer = setInterval(()=> spawnWalkerInRoom(roomCode), WALKER_SPAWN_MS);
  // cleanup expired walkers
  room.cleanupTimer = setInterval(()=> {
    const now = Date.now();
    let removed = false;
    for(const id in room.walkers){
      if(room.walkers[id].expiresAt <= now){ delete room.walkers[id]; removed = true; }
    }
    if(removed) broadcastRoom(roomCode);
  }, 3000);
  // money tick authoritative server-side
  room.moneyTimer = setInterval(()=> {
    for(const id in room.players){
      const pl = room.players[id];
      if(!pl) continue;
      let inc = 0;
      for(const s of pl.collection){
        if(s && s.mps) inc += Number(s.mps);
      }
      if(inc>0) pl.money = (pl.money || 0) + inc;
    }
    broadcastRoom(roomCode);
  }, MONEY_TICK_MS);
  room.timersStarted = true;
  return room;
}

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
  broadcastRoom(roomCode, { type:'walkerSpawn', walker });
}

function broadcastRoom(roomCode, extra = null){
  const room = rooms[roomCode];
  if(!room) return;
  const base = { type:'roomUpdate', players:{}, walkers: Object.values(room.walkers) };
  for(const id in room.players){
    const p = room.players[id];
    base.players[id] = { username: p.username, collection: p.collection, money: p.money };
  }
  for(const id in room.players){
    const p = room.players[id];
    const payload = Object.assign({}, base);
    if(extra) Object.assign(payload, extra);
    payload.you = id;
    try{ p.ws.send(JSON.stringify(payload)); } catch(e){}
  }
}

wss.on('connection', ws => {
  ws.id = makeId(9);
  ws.room = null;
  ws.activeSteals = {};

  ws.on('message', raw => {
    let data;
    try{ data = JSON.parse(raw); }catch(e){ return; }

    // join
    if(data.type === 'joinRoom'){
      const code = String(data.roomCode || 'lobby');
      ws.room = code;
      ensureRoom(code);
      const room = rooms[code];
      room.players[ws.id] = {
        username: String(data.username || 'player'),
        collection: Array(8).fill(null),
        money: Number(data.money ?? 30),
        ws
      };
      broadcastRoom(code);
      return;
    }

    if(!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // update (client may send collection request to save locally; server accepts collection but remains authoritative for money)
    if(data.type === 'update'){
      if(Array.isArray(data.collection)) room.players[ws.id].collection = data.collection;
      // do not accept client's money value to prevent trivial cheating; server will keep its money from ticks/buys/sells
      broadcastRoom(ws.room);
      return;
    }

    // BUY: server must look up walker in room.walkers by itemId and move it to buyer.collection
    if(data.type === 'buy' && data.slot !== undefined && data.itemId){
      const buyer = room.players[ws.id];
      if(!buyer) return;
      const slot = Number(data.slot);
      if(slot < 0 || slot >= buyer.collection.length) return;
      if(buyer.collection[slot] !== null) return;
      const walker = room.walkers[data.itemId];
      if(!walker) {
        // walker disappeared or already bought
        try{ ws.send(JSON.stringify({ type:'error', message:'walker_missing' })); }catch(e){}
        return;
      }
      const cost = Number(walker.cost) || 0;
      if(buyer.money < cost){ try{ ws.send(JSON.stringify({ type:'error', message:'insufficient_funds' })); }catch(e){}; return; }

      // apply purchase
      buyer.money -= cost;
      buyer.collection[slot] = {
        type: walker.type,
        rarity: walker.rarity,
        mps: walker.mps,
        cost: walker.cost
      };
      // remove walker from room
      delete room.walkers[data.itemId];

      // broadcast buy/event + full state
      broadcastRoom(ws.room, { type:'buy', buyerId: ws.id, slot, itemId: data.itemId });
      broadcastRoom(ws.room);
      return;
    }

    // SELL
    if(data.type === 'sell' && data.slot !== undefined){
      const pl = room.players[ws.id];
      if(!pl) return;
      const slot = Number(data.slot);
      const item = pl.collection[slot];
      if(!item) return;
      const refund = Math.max(1, Math.floor((item.mps||0) * 5));
      pl.money = (pl.money || 0) + refund;
      pl.collection[slot] = null;
      broadcastRoom(ws.room, { type:'sell', sellerId: ws.id, slot });
      broadcastRoom(ws.room);
      return;
    }

    // START STEAL
    if(data.type === 'stealStart' && data.victimId !== undefined && data.slot !== undefined){
      const victimId = String(data.victimId);
      const slot = Number(data.slot);
      const victim = room.players[victimId];
      if(!victim) return;
      const key = `${victimId}_${slot}`;
      if(ws.activeSteals[key]) return;
      broadcastRoom(ws.room, { type:'stealStart', thiefId: ws.id, victimId, slot });
      const timeout = setTimeout(()=>{
        const victimPlayer = room.players[victimId];
        const thiefPlayer = room.players[ws.id];
        if(victimPlayer && thiefPlayer){
          const item = victimPlayer.collection[slot];
          if(item){
            const freeIndex = thiefPlayer.collection.findIndex(c => !c);
            if(freeIndex !== -1){
              thiefPlayer.collection[freeIndex] = item;
              victimPlayer.collection[slot] = null;
            } else {
              // optional: notify no space
            }
          }
          broadcastRoom(ws.room, { type:'stealSuccess', thiefId: ws.id, victimId, slot });
          broadcastRoom(ws.room);
        }
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);
      ws.activeSteals[key] = { thiefId: ws.id, timeout };
      return;
    }

    // BLOCK STEAL
    if(data.type === 'stealBlocked' && data.victimId !== undefined && data.slot !== undefined){
      const key = `${data.victimId}_${data.slot}`;
      // find thief client that has this activeSteal
      for(const cid in room.players){
        const client = room.players[cid].ws;
        if(client && client.activeSteals && client.activeSteals[key]){
          const steal = client.activeSteals[key];
          clearTimeout(steal.timeout);
          delete client.activeSteals[key];
          broadcastRoom(ws.room, { type:'stealBlocked', thiefId: steal.thiefId, victimId: data.victimId, slot: data.slot });
          break;
        }
      }
      return;
    }
  });

  ws.on('close', ()=>{
    if(ws.room && rooms[ws.room] && rooms[ws.room].players[ws.id]){
      delete rooms[ws.room].players[ws.id];
      if(Object.keys(rooms[ws.room].players).length === 0){
        const r = rooms[ws.room];
        if(r.spawnTimer) clearInterval(r.spawnTimer);
        if(r.cleanupTimer) clearInterval(r.cleanupTimer);
        if(r.moneyTimer) clearInterval(r.moneyTimer);
        delete rooms[ws.room];
      } else {
        broadcastRoom(ws.room);
      }
    }
  });
});

process.on('SIGINT', ()=> { console.log('shutting down'); wss.close(()=>process.exit(0)); });






