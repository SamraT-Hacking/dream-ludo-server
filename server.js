// /dream-ludo-server/server.js
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const {
    createNewGame,
    addPlayer,
    startGame,
    rollDice,
    movePiece,
    leaveGame,
    sendChatMessage
} = require('./game');

// --- Server & Supabase Setup ---
const PORT = process.env.PORT || 8080;
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, SERVER_SECRET } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_JWT_SECRET || !SERVER_SECRET) {
    console.error("One or more environment variables are missing. Ensure SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, and SERVER_SECRET are set.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
app.use(express.json());
const server = createServer(app);
const wss = new WebSocketServer({ server });

const games = new Map(); // In-memory storage for games

// --- HTTP Endpoints ---
app.get('/health', (req, res) => res.send('OK'));

app.post('/create-game', (req, res) => {
    const { secret, tournamentId, players } = req.body;

    if (secret !== SERVER_SECRET) {
        return res.status(401).send('Unauthorized');
    }
    if (!tournamentId || !players || !Array.isArray(players) || players.length === 0) {
        return res.status(400).send('Bad Request: Missing tournamentId or players.');
    }

    const gameCode = uuidv4().substring(0, 6).toUpperCase();
    const gameOptions = {
        hostId: players[0].id,
        hostName: players[0].name,
        type: 'tournament',
        max_players: players.length,
        players: players, // Pass players to be added during creation
    };

    const gameState = createNewGame(gameCode, gameOptions);
    games.set(gameCode, { state: gameState, clients: new Map(), turnTimer: null });

    console.log(`Game created for tournament ${tournamentId} with code: ${gameCode}`);
    res.status(200).json({ gameCode });
});


// --- WebSocket Server Logic ---
wss.on('connection', async (ws, req) => {
    const gameCode = req.url.slice(1).toUpperCase();
    
    // If game is not in memory, try to create it from a valid tournament
    if (!games.has(gameCode)) {
        try {
            const { data: tournament, error } = await supabase
                .from('tournaments')
                .select('*')
                .eq('game_code', gameCode)
                .single();

            if (error || !tournament) {
                console.log(`Connection rejected: No tournament found for game code ${gameCode}`);
                ws.close(1011, 'Game not found or invalid code.');
                return;
            }
            
            const host = tournament.players_joined[0];
            if (!host) {
                 ws.close(1011, 'Tournament has no players.');
                 return;
            }

            const gameOptions = {
                hostId: host.id,
                hostName: host.name,
                type: 'tournament',
                max_players: tournament.max_players,
            };

            const gameState = createNewGame(gameCode, gameOptions);
            games.set(gameCode, { state: gameState, clients: new Map(), turnTimer: null });
            console.log(`Game room created on-the-fly for tournament ${tournament.title} (${gameCode})`);

        } catch (e) {
            console.error(`Error validating game code ${gameCode} with Supabase:`, e);
            ws.close(1011, 'Server error validating game.');
            return;
        }
    }

    ws.on('message', async (message) => {
        try {
            const { action, payload } = JSON.parse(message);
            const game = games.get(gameCode);
            if (!game) return;

            if (action === 'AUTH') {
                if (ws.userId) return;

                const { data: { user }, error } = await supabase.auth.getUser(payload.token);
                if (error || !user) {
                    ws.send(JSON.stringify({ type: 'AUTH_FAILURE', payload: { message: 'Invalid token.' } }));
                    ws.close(4001, 'Auth Failed');
                    return;
                }
                
                ws.userId = user.id;
                ws.userName = user.user_metadata.full_name || 'Player';
                ws.gameCode = gameCode;
                
                game.clients.set(ws.userId, ws);

                if (!game.state.players.some(p => p.playerId === ws.userId)) {
                    addPlayer(game.state, ws.userId, ws.userName);
                }

                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                console.log(`Player ${ws.userName} connected to game ${gameCode}`);
                broadcastGameState(gameCode);
                
                // Check for auto-start condition
                if (game.state.type === 'tournament' && game.state.players.length === game.state.max_players && game.state.gameStatus === 'Setup') {
                    console.log(`Tournament game ${gameCode} is full. Starting automatically.`);
                    setTimeout(() => {
                        startGame(game.state, null); // System start
                        broadcastGameState(gameCode);
                    }, 1500);
                }
                return;
            }

            if (!ws.userId) return ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Not authenticated.' } }));

            const player = game.state.players.find(p => p.playerId === ws.userId);
            if (!player || player.isRemoved) return;

            switch (action) {
                case 'START_GAME': startGame(game.state, ws.userId); break;
                case 'ROLL_DICE': rollDice(game.state, ws.userId); break;
                case 'MOVE_PIECE': movePiece(game.state, ws.userId, payload.pieceId); break;
                case 'LEAVE_GAME': leaveGame(game.state, ws.userId); break;
                case 'SEND_CHAT_MESSAGE': sendChatMessage(game.state, ws.userId, payload.text); break;
                default: console.warn(`Unknown action: ${action}`); return;
            }

            broadcastGameState(gameCode);

        } catch (err) {
            console.error('Error processing message:', err);
            ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'An internal server error occurred.' } }));
        }
    });

    ws.on('close', () => {
        const gameCode = ws.gameCode;
        if (!gameCode) return;
        
        const game = games.get(gameCode);
        if (game && ws.userId) {
            game.clients.delete(ws.userId);
            console.log(`Player ${ws.userName} disconnected from ${gameCode}`);
            
            leaveGame(game.state, ws.userId);
            broadcastGameState(gameCode);

            if (game.clients.size === 0) {
                console.log(`Game ${gameCode} is empty, removing.`);
                clearTimeout(game.turnTimer);
                games.delete(gameCode);
            }
        }
    });
});

function broadcastGameState(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;

    const statePayload = JSON.stringify({ type: 'GAME_STATE_UPDATE', payload: game.state });

    for (const client of game.clients.values()) {
        if (client.readyState === client.OPEN) {
            client.send(statePayload);
        }
    }
}

server.listen(PORT, () => console.log(`Dream Ludo server listening on port ${PORT}`));
