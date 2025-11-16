// server.js
const http = require('http');
const WebSocket = require('ws'); // only declared once

const PORT = process.env.PORT || 8080;

const server = http.createServer();
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const wss = new WebSocket.Server({ server });

console.log("WebSocket server running");

// --- Data structures ---
const rooms = {}; // roomCode => { players: {id: {username, collection, money, ws}} }
const STEAL_TIMEOUT = 15000;

// --- WebSocket connection ---
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
      if(!rooms[code]) rooms[code] = { players:{} };
      rooms[code].players[ws.id] = {
        username: data.username || 'player' + Math.floor(Math.random()*9999),
        collection: Array(8).fill(null),
        money: data.money ?? 30,
        ws
      };
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
    if(data.type==='buy' && data.slot !== undefined && data.itemId){
      // simulate item purchase
      room.players[ws.id].collection[data.slot] = { id:data.itemId, type:'spermbob', mps:1, cost:10, rarity:'common' };
      room.players[ws.id].money -= 10; // sample cost
      broadcastRoom(ws.room);
    }

    // SELL
    if(data.type==='sell' && data.slot !== undefined){
      const item = room.players[ws.id].collection[data.slot];
      if(item){
        room.players[ws.id].money += Math.floor((item.mps||0)*5); // refund formula
        room.players[ws.id].collection[data.slot] = null;
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

  ws.on('close', ()=> {
    if(ws.room && rooms[ws.room] && rooms[ws.room].players[ws.id]){
      delete rooms[ws.room].players[ws.id];
      if(Object.keys(rooms[ws.room].players).length === 0) delete rooms[ws.room];
      else broadcastRoom(ws.room);
    }
  });
});

// --- Broadcast to all players in a room ---
function broadcastRoom(code, extra=null){
  const room = rooms[code];
  if(!room) return;
  const payload = { type:'roomUpdate', players:{} };
  for(const id in room.players){
    const p = room.players[id];
    payload.players[id] = {
      username: p.username,
      collection: p.collection,
      money: p.money
    };
  }
  if(extra) Object.assign(payload, extra);

  for(const id in room.players){
    const p = room.players[id];
    try { p.ws.send(JSON.stringify(payload)); } catch(e){}
  }
}






