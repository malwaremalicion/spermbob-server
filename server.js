const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

console.log("WebSocket server running");

const rooms = {}; // roomCode => { players: {id: {username, collection, money, ws}}, walkers: [] }
const STEAL_TIMEOUT = 15000;
const WALKER_SPAWN_INTERVAL = 1000; // 1 second

function spawnWalker(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const id = Math.random().toString(36).substr(2, 9);
  const rarities = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  const rarityIndex = Math.floor(Math.random() * rarities.length);
  const rarity = rarities[rarityIndex];
  const cost = (rarityIndex + 1) * 10;
  const mps = (rarityIndex + 1);
  const type = Math.random() < 0.5 ? 'spermbob' : 'bellbob';
  const walker = { id, type, rarity, cost, mps, pos: 0 };
  room.walkers.push(walker);
  broadcastRoom(roomCode, { type: 'walkerSpawn', walker });
}

function moveWalkers() {
  for (const code in rooms) {
    const room = rooms[code];
    const finished = [];
    room.walkers.forEach(w => {
      w.pos += 2; // speed in pixels per tick
      if (w.pos > 600) finished.push(w.id); // road width ~600px
    });
    finished.forEach(id => {
      const idx = room.walkers.findIndex(w => w.id === id);
      if (idx !== -1) room.walkers.splice(idx, 1);
    });
    if (room.walkers.length > 0) broadcastRoom(code);
  }
}
setInterval(moveWalkers, 50); // smooth movement

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).substr(2,9);
  ws.room = null;
  ws.activeSteals = {};

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch(e){ return; }

    // JOIN ROOM
    if(data.type === 'joinRoom'){
      const code = data.roomCode || 'lobby';
      ws.room = code;
      if(!rooms[code]) rooms[code] = { players:{}, walkers: [] };
      rooms[code].players[ws.id] = {
        username: data.username || 'player'+Math.floor(Math.random()*9999),
        collection: Array(8).fill(null),
        money: data.money ?? 30,
        ws
      };
      // start walker spawn loop for this room
      if(!rooms[code].walkerInterval){
        rooms[code].walkerInterval = setInterval(()=>spawnWalker(code), WALKER_SPAWN_INTERVAL);
      }
      broadcastRoom(code);
    }

    if(!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // UPDATE COLLECTION/MONEY
    if(data.type === 'update'){
      if(data.collection) room.players[ws.id].collection = data.collection;
      if(data.money!==undefined) room.players[ws.id].money = data.money;
      broadcastRoom(ws.room);
    }

    // BUY
    if(data.type==='buy' && data.slot!==undefined && data.itemId){
      const walker = room.walkers.find(w=>w.id===data.itemId);
      if(!walker) return;
      room.players[ws.id].collection[data.slot] = walker;
      room.players[ws.id].money -= walker.cost;
      room.walkers = room.walkers.filter(w=>w.id!==data.itemId);
      broadcastRoom(ws.room);
    }

    // SELL
    if(data.type==='sell' && data.slot!==undefined){
      const item = room.players[ws.id].collection[data.slot];
      if(item){
        room.players[ws.id].money += Math.floor(item.mps*5);
        room.players[ws.id].collection[data.slot] = null;
        broadcastRoom(ws.room);
      }
    }

    // STEAL
    if(data.type==='stealStart' && data.victimId!==undefined && data.slot!==undefined){
      const victim = room.players[data.victimId];
      if(!victim) return;
      const key = `${data.victimId}_${data.slot}`;
      if(ws.activeSteals[key]) return;

      broadcastRoom(ws.room, { type:'stealStart', thiefId: ws.id, victimId:data.victimId, slot:data.slot });

      const timeout = setTimeout(()=>{
        const thief = room.players[ws.id];
        const item = victim.collection[data.slot];
        if(item){
          const free = thief.collection.findIndex(c=>!c);
          if(free!==-1){
            thief.collection[free] = item;
            victim.collection[data.slot] = null;
          }
        }
        broadcastRoom(ws.room, { type:'stealSuccess', thiefId: ws.id, victimId:data.victimId, slot:data.slot });
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);

      ws.activeSteals[key] = { thiefId: ws.id, timeout };
    }

    if(data.type==='stealBlocked' && data.victimId!==undefined && data.slot!==undefined){
      const key = `${data.victimId}_${data.slot}`;
      const steal = ws.activeSteals[key];
      if(steal){
        clearTimeout(steal.timeout);
        delete ws.activeSteals[key];
        broadcastRoom(ws.room, { type:'stealBlocked', thiefId: steal.thiefId, victimId:data.victimId, slot:data.slot });
      }
    }
  });

  ws.on('close', ()=>{
    if(ws.room && rooms[ws.room] && rooms[ws.room].players[ws.id]){
      delete rooms[ws.room].players[ws.id];
      if(Object.keys(rooms[ws.room].players).length===0){
        clearInterval(rooms[ws.room].walkerInterval);
        delete rooms[ws.room];
      } else broadcastRoom(ws.room);
    }
  });
});

function broadcastRoom(code, extra=null){
  const room = rooms[code];
  if(!room) return;
  const payload = { type:'roomUpdate', players:{}, walkers: room.walkers };
  for(const id in room.players){
    const p = room.players[id];
    payload.players[id] = { username: p.username, collection: p.collection, money: p.money };
  }
  if(extra) Object.assign(payload, extra);
  for(const id in room.players){
    const p = room.players[id];
    try{ p.ws.send(JSON.stringify(payload)); } catch(e){}
  }
}


