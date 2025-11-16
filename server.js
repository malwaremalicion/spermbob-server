const WebSocket = require("ws");
const PORT = process.env.PORT || 10000;

const wss = new WebSocket.Server({ port: PORT });

let rooms = {};

wss.on("connection", ws => {
  ws.on("message", msg => {
    let data = {};
    try { data = JSON.parse(msg); } catch(e){ return; }

    if (data.type === "joinRoom") {
      ws.room = data.roomCode;
      ws.username = data.username;

      if (!rooms[ws.room]) rooms[ws.room] = {};
      rooms[ws.room][ws.username] = { collection: [], money: 30 };

      broadcastRoom(ws.room);
    }

    if (data.type === "update") {
      if (!rooms[ws.room]) return;
      rooms[ws.room][ws.username] = { 
        collection: data.collection,
        money: data.money
      };
      broadcastRoom(ws.room);
    }
  });

  ws.on("close", () => {
    if (!ws.room || !rooms[ws.room]) return;
    delete rooms[ws.room][ws.username];
    broadcastRoom(ws.room);
  });
});

function broadcastRoom(room) {
  for (let client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.room === room) {
      client.send(JSON.stringify({
        type: "roomUpdate",
        players: rooms[room]
      }));
    }
  }
}

console.log("WS server running on port " + PORT);
