// server.js
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
// You will need to create the game logic in game.js
// const { createNewGame, handlePlayerAction } = require('./game');

// --- Server & Supabase Setup ---
const PORT = process.env.PORT || 8080;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Simple health check endpoint for Render
app.get('/health', (req, res) => res.send('OK'));

// In-memory storage for active games. In production, consider Redis.
const games = new Map();

// --- WebSocket Server Logic ---
wss.on('connection', (ws, req) => {
    const gameCode = req.url.slice(1); // Get game code from URL: /<code>
    
    // 1. Await Authentication
    ws.on('message', async (message) => {
        const { action, payload } = JSON.parse(message);

        if (action === 'AUTH') {
            try {
                // 2. Verify JWT from Supabase
                const { data: { user }, error } = await supabase.auth.getUser(payload.token);
                if (error || !user) {
                    ws.send(JSON.stringify({ type: 'AUTH_FAILURE', payload: { message: 'Invalid token.' } }));
                    ws.close();
                    return;
                }
                
                // Attach user info to the WebSocket connection
                ws.userId = user.id;
                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));

                // 3. Add player to the game room
                let game = games.get(gameCode);
                // If the game doesn't exist, this is where you'd create it
                // based on your game creation logic (e.g., from a tournament).
                if (!game) {
                    // This logic needs to be robust. For now, let's assume game is created elsewhere.
                    ws.close(); return;
                }
                
                game.players.set(ws.userId, ws); // Add player WebSocket to the room
                
                // 4. Broadcast the updated game state to everyone in the room
                broadcastGameState(gameCode);

            } catch (err) {
                ws.send(JSON.stringify({ type: 'AUTH_FAILURE', payload: { message: 'Auth error.' } }));
                ws.close();
            }
        } else {
            // Handle other game actions (ROLL_DICE, MOVE_PIECE, etc.)
            // These should only be processed AFTER a user is authenticated.
            if (!ws.userId) return; // Ignore messages from unauthenticated clients

            // You would call your game logic handler here
            // const updatedGameState = handlePlayerAction(gameCode, ws.userId, action, payload);
            // games.set(gameCode, updatedGameState);
            
            // And broadcast the new state
            broadcastGameState(gameCode);
        }
    });

    ws.on('close', () => {
        // Handle player disconnection
        // Remove player from the game room and notify others.
        let game = games.get(gameCode);
        if (game && ws.userId) {
            game.players.delete(ws.userId);
            // You might want to update the game state to mark player as disconnected
            broadcastGameState(gameCode);
        }
    });
});

function broadcastGameState(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;

    const statePayload = JSON.stringify({
        type: 'GAME_STATE_UPDATE',
        payload: game.state // `game.state` should be the GameState object
    });

    for (const client of game.players.values()) {
        if (client.readyState === client.OPEN) {
            client.send(statePayload);
        }
    }
}

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));