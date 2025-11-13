require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

// IMPORT GAME LOGIC
const {
    createNewGame,
    addPlayer,
    startGame,
    rollDice,
    movePiece,
    leaveGame,
    sendChatMessage
} = require("./game");

const PORT = process.env.PORT || 8080;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();
const server = createServer(app);

// health check
app.get("/", (req, res) => res.send("WebSocket Server Running"));
app.get("/health", (req, res) => res.send("OK"));

// WebSocket upgrade handler (Render requirement)
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws/")) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

// In-memory game storage
const games = new Map();

// heartbeat to keep Render alive
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", heartbeat);

    const gameCode = req.url.replace("/ws/", "");
    console.log("WS connected for room:", gameCode);

    ws.on("message", async (raw) => {
        const { action, payload } = JSON.parse(raw);

        // ---------- 1. AUTH ----------
        if (action === "AUTH") {
            const { data, error } = await supabase.auth.getUser(payload.token);

            if (error || !data.user) {
                ws.send(JSON.stringify({ type: "AUTH_FAILURE" }));
                return ws.close();
            }

            ws.userId = data.user.id;
            ws.userName = payload.name || "Player";

            ws.send(JSON.stringify({ type: "AUTH_SUCCESS" }));

            // CREATE GAME IF NOT EXISTS
            if (!games.get(gameCode)) {
                console.log("Creating new game:", gameCode);
                games.set(
                    gameCode,
                    createNewGame(gameCode, {
                        hostId: ws.userId,
                        hostName: ws.userName
                    })
                );
            }

            const game = games.get(gameCode);

            // ADD PLAYER TO GAME
            addPlayer(game, ws.userId, ws.userName);

            // Track WebSocket instance
            if (!game.playersWS) game.playersWS = new Map();
            game.playersWS.set(ws.userId, ws);

            broadcastGameState(gameCode);
            return;
        }

        // ---------- 2. GAME ACTIONS ----------
        const game = games.get(gameCode);
        if (!game || !ws.userId) return;

        if (action === "START_GAME") {
            startGame(game, ws.userId);
        }
        if (action === "ROLL_DICE") {
            rollDice(game, ws.userId);
        }
        if (action === "MOVE_PIECE") {
            movePiece(game, ws.userId, payload.pieceId);
        }
        if (action === "LEAVE_GAME") {
            leaveGame(game, ws.userId);
        }
        if (action === "SEND_CHAT") {
            sendChatMessage(game, ws.userId, payload.text);
        }

        broadcastGameState(gameCode);
    });

    ws.on("close", () => {
        const game = games.get(gameCode);
        if (game && ws.userId) {
            leaveGame(game, ws.userId);
            game.playersWS.delete(ws.userId);
            broadcastGameState(gameCode);
        }
    });
});

// heartbeat interval
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Broadcast function
function broadcastGameState(gameCode) {
    const game = games.get(gameCode);
    if (!game || !game.playersWS) return;

    const payload = JSON.stringify({
        type: "GAME_STATE_UPDATE",
        payload: game
    });

    for (const ws of game.playersWS.values()) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
    }
}

server.listen(PORT, () => {
    console.log("Server running on", PORT);
});
