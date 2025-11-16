// /dream-ludo-server/server.js
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const {
    createNewGame, addPlayer, startGame,
    initiateRoll, completeRoll, movePiece,
    leaveGame, sendChatMessage, handleMissedTurn,
    handlePlayerDisconnect, handlePlayerReconnect, advanceTurn
} = require('./game');

// --- Server & Supabase Setup ---
const PORT = process.env.PORT || 8080;
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_JWT_SECRET) {
    console.error("One or more Supabase environment variables are missing.");
    process.exit(1);
}

// The supabase client requires a service_role key to bypass RLS for server-side operations.
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY);
const games = new Map(); // In-memory storage for active games
const RECONNECT_GRACE_PERIOD = 30000; // 30 seconds

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (req, res) => res.send('OK'));

// --- WebSocket Server Logic ---
wss.on('connection', async (ws, req) => {
    const gameCode = req.url.slice(1).toUpperCase();
    
    // The logic to fetch completed/archived games from a different table has been removed
    // as it created complexity. Clients will now just see a "Game not found" error if
    // the game is over and removed from memory, which is a simpler and acceptable flow.
    
    if (!games.has(gameCode)) {
        try {
            const { data: tournament, error: tournamentError } = await supabase
                .from('tournaments')
                .select('*')
                .eq('game_code', gameCode)
                .single();

            if (tournamentError || !tournament) {
                ws.close(1011, 'Game not found.');
                return;
            }

            if (tournament.status !== 'ACTIVE') {
                ws.close(1011, `Tournament is not active. Status: ${tournament.status}`);
                return;
            }
            
            const gameOptions = {
                hostId: tournament.players_joined[0]?.id,
                type: 'tournament',
                max_players: tournament.max_players,
            };

            const gameState = createNewGame(gameCode, gameOptions);
            games.set(gameCode, { state: gameState, clients: new Map(), turnTimer: null, reconnectTimers: new Map() });
            console.log(`Game room created on-the-fly for tournament ${tournament.title} (${gameCode})`);

        } catch (e) {
            console.error(`Error validating game code ${gameCode}:`, e);
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

                const existingPlayer = game.state.players.find(p => p.playerId === ws.userId);
                if (existingPlayer && existingPlayer.disconnected) {
                    clearTimeout(game.reconnectTimers.get(ws.userId));
                    game.reconnectTimers.delete(ws.userId);
                    handlePlayerReconnect(game.state, ws.userId);
                } else if (!existingPlayer) {
                    addPlayer(game.state, ws.userId, ws.userName);
                }

                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                broadcastGameState(gameCode);
                
                if (game.state.type === 'tournament' && game.state.players.length === game.state.max_players && game.state.gameStatus === 'Setup') {
                    setTimeout(() => {
                        startGame(game.state, null);
                        broadcastGameState(gameCode);
                        startTurnTimer(gameCode);
                    }, 1500);
                }
                return;
            }

            if (!ws.userId) return;
            const player = game.state.players.find(p => p.playerId === ws.userId);
            if (!player || player.isRemoved) return;

            if (game.state.players[game.state.currentPlayerIndex].playerId === ws.userId) {
                startTurnTimer(gameCode);
            }

            switch (action) {
                case 'START_GAME':
                    startGame(game.state, ws.userId);
                    startTurnTimer(gameCode);
                    break;
                case 'ROLL_DICE':
                    initiateRoll(game.state, ws.userId);
                    broadcastGameState(gameCode);
                    setTimeout(() => {
                        const shouldAdvance = completeRoll(game.state, ws.userId);
                        if (shouldAdvance) {
                            setTimeout(() => {
                                advanceTurn(game.state);
                                broadcastGameState(gameCode);
                                startTurnTimer(gameCode);
                            }, 1000);
                        } else {
                           broadcastGameState(gameCode);
                        }
                    }, 1000);
                    return;
                case 'MOVE_PIECE': movePiece(game.state, ws.userId, payload.pieceId); startTurnTimer(gameCode); break;
                case 'LEAVE_GAME': leaveGame(game.state, ws.userId); startTurnTimer(gameCode); break;
                case 'SEND_CHAT_MESSAGE': sendChatMessage(game.state, ws.userId, payload.text); break;
                default: return;
            }

            broadcastGameState(gameCode);

            if (game.state.gameStatus === 'Finished') {
                handleGameFinish(gameCode);
            }

        } catch (err) {
            console.error('Error processing message:', err);
        }
    });

    ws.on('close', () => {
        const gameCode = ws.gameCode;
        if (!gameCode || !ws.userId) return;
        
        const game = games.get(gameCode);
        if (game) {
            game.clients.delete(ws.userId);
            handlePlayerDisconnect(game.state, ws.userId);
            broadcastGameState(gameCode);

            const reconnectTimer = setTimeout(() => {
                const game = games.get(gameCode);
                if (game) {
                    leaveGame(game.state, ws.userId);
                    broadcastGameState(gameCode);
                    if (game.state.gameStatus === 'Finished') {
                        handleGameFinish(gameCode);
                    }
                }
            }, RECONNECT_GRACE_PERIOD);
            game.reconnectTimers.set(ws.userId, reconnectTimer);
        }
    });
});

function broadcastGameState(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;
    const statePayload = JSON.stringify({ type: 'GAME_STATE_UPDATE', payload: game.state });
    for (const client of game.clients.values()) {
        if (client.readyState === client.OPEN) client.send(statePayload);
    }
}

function startTurnTimer(gameCode) {
    const game = games.get(gameCode);
    if (!game || game.state.gameStatus !== 'Playing') return;

    clearTimeout(game.turnTimer);
    game.state.turnTimeLeft = 30;

    const timerTick = () => {
        if (game.state.gameStatus !== 'Playing') return;
        
        game.state.turnTimeLeft--;
        if (game.state.turnTimeLeft <= 0) {
            handleMissedTurn(game.state);
            broadcastGameState(gameCode);
            if (game.state.gameStatus === 'Finished') {
                handleGameFinish(gameCode);
            } else {
                startTurnTimer(gameCode); // Start timer for the next player
            }
        } else {
            game.turnTimer = setTimeout(timerTick, 1000);
            if(game.state.turnTimeLeft % 5 === 0) broadcastGameState(gameCode);
        }
    };
    game.turnTimer = setTimeout(timerTick, 1000);
}

async function archiveGameData(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;

    const { state: finalState } = game;
    const { data: tournament, error: findError } = await supabase
        .from('tournaments')
        .select('id')
        .eq('game_code', gameCode)
        .single();
        
    if (findError || !tournament) {
        console.error(`Could not find tournament ID for game code ${gameCode}:`, findError);
        return;
    }
    const tournamentId = tournament.id;

    // Archive chat messages
    if (finalState.chatMessages && finalState.chatMessages.length > 0) {
        const chatToInsert = finalState.chatMessages.map(msg => ({
            tournament_id: tournamentId,
            user_id: msg.playerId,
            username: msg.name,
            message_text: msg.text,
        }));
        const { error: chatError } = await supabase.from('chat_messages').insert(chatToInsert);
        if (chatError) console.error(`Failed to archive chat for ${gameCode}:`, chatError);
    }

    // Archive turn history
    if (finalState.turn_history && finalState.turn_history.length > 0) {
        const turnsToInsert = finalState.turn_history.map(turn => ({
            tournament_id: tournamentId,
            user_id: turn.userId,
            username: turn.name,
            description: turn.description,
        }));
        const { error: turnError } = await supabase.from('game_turn_history').insert(turnsToInsert);
        if (turnError) console.error(`Failed to archive turns for ${gameCode}:`, turnError);
    }
}

async function handleGameFinish(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;

    console.log(`Game ${gameCode} finished. Archiving to database.`);
    clearTimeout(game.turnTimer);
    game.turnTimer = null;

    // Persist chat and turn history
    await archiveGameData(gameCode);

    // After archiving, we can remove the game from memory.
    // The main game flow will handle tournament status updates via RPCs.
    setTimeout(() => {
        games.delete(gameCode);
        console.log(`Game ${gameCode} removed from memory.`);
    }, 5000);
}

server.listen(PORT, () => console.log(`Dream Ludo server listening on port ${PORT}`));
