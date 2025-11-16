// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });
console.log("WebSocket server running on ws://localhost:8080");

const rooms = {}; // roomCode => { players: {id: {username, collection, money, ws}}, walkers: [] }
const STEAL_TIMEOUT = 15000;

function generateWalker(id) {
  return {
    id,
    type: Math.random() > 0.5 ? 'bellbob' : 'spermbob',
    rarity: ['Common','Uncommon','Rare','Epic'][Math.floor(Math.random()*4)],
    cost: Math.floor(Math.random() * 50 + 10),
    mps: Math.floor(Math.random() * 10 + 1)
  };
}

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).substr(2,9);
  ws.room = null;
  ws.activeSteals = {}; // key victimId_slot -> {thiefId, timeout}

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch(e){ return; }

    // JOIN ROOM
    if(data.type === 'joinRoom'){
      const code = data.roomCode || 'lobby';
      ws.room = code;
      if(!rooms[code]) rooms[code] = { players: {}, walkers: [] };
      rooms[code].players[ws.id] = { username: data.username, collection: Array(8).fill(null), money: data.money ?? 30, ws };
      
      // Spawn initial walkers if room has none
      if(rooms[code].walkers.length === 0){
        for(let i=0;i<5;i++) rooms[code].walkers.push(generateWalker(Math.random().toString(36).substr(2,9)));
      }

      broadcastRoom(code, ws.id);
    }

    if(!ws.room || !rooms[ws.room]) return;
    const room = rooms[ws.room];

    // UPDATE COLLECTION/MONEY
    if(data.type === 'update'){
      if(data.collection) room.players[ws.id].collection = data.collection;
      if(data.money !== undefined) room.players[ws.id].money = data.money;
      broadcastRoom(ws.room, ws.id);
    }

    // BUY
    if(data.type==='buy' && data.slot !== undefined && data.itemId){
      const walkerIndex = room.walkers.findIndex(w => w.id===data.itemId);
      if(walkerIndex !== -1){
        const walker = room.walkers[walkerIndex];
        room.players[ws.id].collection[data.slot] = walker;
        room.players[ws.id].money -= walker.cost ?? 0;
        room.walkers.splice(walkerIndex,1); // remove from road
        broadcastRoom(ws.room, ws.id);
      }
    }

    // SELL
    if(data.type==='sell' && data.slot !== undefined){
      const item = room.players[ws.id].collection[data.slot];
      if(item){
        room.players[ws.id].money += Math.floor((item.mps||0)*5);
        room.players[ws.id].collection[data.slot] = null;
        broadcastRoom(ws.room, ws.id);
      }
    }

    // START STEAL
    if(data.type==='stealStart' && data.victimId !== undefined && data.slot !== undefined){
      const victim = room.players[data.victimId];
      if(!victim) return;
      const key = `${data.victimId}_${data.slot}`;
      if(ws.activeSteals[key]) return;

      broadcastRoom(ws.room, ws.id, { type:'stealStart', thiefId: ws.id, victimId:data.victimId, slot:data.slot });

      const timeout = setTimeout(()=>{
        const victimPlayer = room.players[data.victimId];
        const thiefPlayer = room.players[ws.id];
        if(victimPlayer && thiefPlayer){
          const item = victimPlayer.collection[data.slot];
          if(item){
            const freeIndex = thiefPlayer.collection.findIndex(c=>!c);
            if(freeIndex!==-1){
              thiefPlayer.collection[freeIndex] = item;
              victimPlayer.collection[data.slot] = null;
            }
          }
          broadcastRoom(ws.room, ws.id, { type:'stealSuccess', thiefId: ws.id, victimId:data.victimId, slot:data.slot });
        }
        delete ws.activeSteals[key];
      }, STEAL_TIMEOUT);

      ws.activeSteals[key] = { thiefId: ws.id, timeout };
    }

    // BLOCK STEAL
    if(data.type==='stealBlocked' && data.victimId!==undefined){
      Object.keys(ws.activeSteals).forEach(key=>{
        const steal = ws.activeSteals[key];
        if(steal && steal.thiefId && data.victimId === steal.thiefId){
          clearTimeout(steal.timeout);
          delete ws.activeSteals[key];
          broadcastRoom(ws.room, ws.id, { type:'stealBlocked', thiefId: steal.thiefId, victimId: data.victimId });
        }
      });
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

function broadcastRoom(code, you=null, extra=null){
  const room = rooms[code];
  if(!room) return;
  const payload = { type:'roomUpdate', players:{}, walkers: room.walkers, you };
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


