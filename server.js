const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("WebSocket server running on ws://localhost:8080");

const rooms = {}; // roomCode => { players: {id: {username, collection, money, ws}}, nextWalkerId: 1 }
const STEAL_TIMEOUT = 15000;
const WALKER_INTERVAL = 1000; // 1 second

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).substr(2, 9);
  ws.room = null;
  ws.activeSteals = {}; // key victimId_slot -> {thiefId, timeout}

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch(e){ return; }

    // JOIN ROOM
    if(data.type === 'joinRoom'){
      const code = data.roomCode;
      ws.room = code;
      if(!rooms[code]) rooms[code] = { players:{}, walkers:[], nextWalkerId:1 };
      rooms[code].players[ws.id] = { username: data.username, collection: Array(8).fill(null), money: data.money ?? 30, ws };
      broadcastRoom(code);
    }

    if(!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // UPDATE COLLECTION/MONEY
    if(data.type === 'update'){
      if(data.collection) room.players[ws.id].collection = data.collection;
      if(data.money !== undefined) room.players[ws.id].money = data.money;
      broadcastRoom(ws.room);
    }

    // BUY
    if(data.type==='buy' && data.slot !== undefined && data.item){
      const player = room.players[ws.id];
      if(!player) return;
      player.collection[data.slot] = data.item;
      player.money -= data.item.cost ?? 0;
      broadcastRoom(ws.room);
    }

    // SELL
    if(data.type==='sell' && data.slot !== undefined){
      const player = room.players[ws.id];
      if(!player) return;
      const item = player.collection[data.slot];
      if(item){
        player.money += Math.floor((item.mps||0)*5);
        player.collection[data.slot] = null;
        broadcastRoom(ws.room);
      }
    }

    // START STEAL
    if(data.type==='stealStart' && data.victimId !== undefined && data.slot !== undefined){
      const victim = room.players[data.victimId];
      if(!victim) return;
      const key = `${data.victimId}_${data.slot}`;
      if(ws.activeSteals[key]) return;

      broadcastRoom(ws.room, { type:'stealStart', thiefId: ws.id, victimId:data.victimId, slot:data.slot });

      const timeout = setTimeout(()=>{
        const victimPlayer = room.players[data.victimId];
        const thiefPlayer = room.players[ws.id];
        if(victimPlayer && thiefPlayer){
          const item = victimPlayer.collection[data.slot];
          if(item){
            const freeIndex = thiefPlayer.collection.findIndex(c => !c);
            if(freeIndex!==-1){
              thiefPlayer.collection[freeIndex] = item;
              victimPlayer.collection[data.slot] = null;
            }
          }
          broadcastRoom(ws.room, { type:'stealSuccess', thiefId: ws.id, victimId:data.victimId, slot:data.slot });
          broadcastRoom(ws.room);
        }
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);

      ws.activeSteals[key] = { thiefId: ws.id, timeout };
    }

    // BLOCK STEAL
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
      if(Object.keys(rooms[ws.room].players).length===0) delete rooms[ws.room];
      else broadcastRoom(ws.room);
    }
  });
});

// Broadcast room state
function broadcastRoom(code, extra=null){
  const room = rooms[code];
  if(!room) return;
  const payload = { type:'roomUpdate', players:{}, walkers:room.walkers };
  for(const id in room.players){
    const p = room.players[id];
    payload.players[id] = { username: p.username, collection: p.collection, money: p.money };
  }
  if(extra) Object.assign(payload, extra);

  for(const id in room.players){
    const p = room.players[id];
    try { p.ws.send(JSON.stringify(payload)); } catch(e){}
  }
}

// Spawn a walker every second for each room
setInterval(()=>{
  for(const code in rooms){
    const room = rooms[code];
    const walker = {
      id: 'w' + room.nextWalkerId++,
      type: Math.random()<0.5 ? 'bellbob' : 'spermbob',
      rarity: ['common','uncommon','rare'][Math.floor(Math.random()*3)],
      cost: Math.floor(Math.random()*50 + 10),
      mps: Math.floor(Math.random()*5 + 1)
    };
    room.walkers.push(walker);
    broadcastRoom(code, { type:'walkerSpawn', walker });
    // Remove after 10s
    setTimeout(()=>{
      room.walkers = room.walkers.filter(w=>w.id!==walker.id);
      broadcastRoom(code);
    },10000);
  }
}, WALKER_INTERVAL);
