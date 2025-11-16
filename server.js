const WebSocket = require("ws");
const PORT = process.env.PORT || 10000;

const wss = new WebSocket.Server({ port: PORT });
console.log("WebSocket server running on port", PORT);

let rooms = {}; // { roomCode: { players: {id: {username, money, collection}}, } }

function broadcastRoom(roomCode, extra = null) {
    const room = rooms[roomCode];
    if (!room) return;

    Object.values(wss.clients).forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.room === roomCode) {
            client.send(JSON.stringify({
                type: "roomUpdate",
                you: client.id,
                players: room.players,
                ...extra
            }));
        }
    });
}

wss.on("connection", ws => {
    ws.id = Math.random().toString(36).slice(2, 9);
    ws.room = null;

    ws.on("message", msg => {
        let data;
        try { data = JSON.parse(msg); } 
        catch { return; }

        // ---- JOIN ROOM ----
        if (data.type === "joinRoom") {
            const { username, roomCode } = data;
            ws.room = roomCode;

            if (!rooms[roomCode]) {
                rooms[roomCode] = { players: {} };
            }

            rooms[roomCode].players[ws.id] = {
                username,
                money: 30,
                collection: Array(8).fill(null)
            };

            broadcastRoom(roomCode);
        }

        // ---- UPDATE PLAYER ----
        if (data.type === "update") {
            const room = rooms[ws.room];
            if (!room) return;

            if (room.players[ws.id]) {
                room.players[ws.id].collection = data.collection;
                room.players[ws.id].money = data.money;
            }

            broadcastRoom(ws.room);
        }

        // ---- BUY ----
        if (data.type === "buy") {
            broadcastRoom(ws.room, { type: "buy", itemId: data.itemId });
        }

        // ---- STEAL START ----
        if (data.type === "stealStart") {
            broadcastRoom(ws.room, {
                type: "stealStart",
                thiefId: ws.id,
                victimId: data.victimId,
                slot: data.slot
            });
        }

        // ---- STEAL BLOCKED ----
        if (data.type === "stealBlocked") {
            broadcastRoom(ws.room, {
                type: "stealBlocked",
                thiefId: ws.id,
                victimId: data.victimId,
                slot: data.slot
            });
        }

        // ---- STEAL SUCCESS ----
        if (data.type === "stealSuccess") {
            const room = rooms[ws.room];
            if (!room) return;

            const victim = room.players[data.victimId];
            const thief = room.players[ws.id];

            if (victim && thief) {
                thief.collection[data.slot] = victim.collection[data.slot];
                victim.collection[data.slot] = null;
            }

            broadcastRoom(ws.room, {
                type: "stealSuccess",
                thiefId: ws.id,
                victimId: data.victimId,
                slot: data.slot
            });
        }
    });

    ws.on("close", () => {
        if (ws.room && rooms[ws.room]) {
            delete rooms[ws.room].players[ws.id];
            broadcastRoom(ws.room);
        }
    });
});
