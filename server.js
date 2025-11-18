
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
    advanceTurn
} = require('./game');

// --- Server & Supabase Setup ---
const PORT = process.env.PORT || 8080;
// **MODIFIED**: Now requires SUPABASE_SERVICE_KEY for admin operations.
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: One or more Supabase environment variables are missing.");
    console.error("Ensure SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_KEY are set in your .env file.");
    process.exit(1);
}

// **MODIFIED**: Initialize with the service key to bypass RLS for server operations.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const games = new Map(); // In-memory storage for active games

const app = express();

// CORS Middleware
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // Allow all origins for now, restrict in prod if needed
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (req, res) => res.send('OK'));

// --- Payment Endpoints (UddoktaPay) ---

// Initialize Payment
app.post('/api/payment/init', async (req, res) => {
    const { userId, amount, gateway, redirectBaseUrl } = req.body;

    if (!userId || !amount || !redirectBaseUrl) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // 1. Fetch User Profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('username, id') // We don't have email in profiles, using dummy or metadata if possible
            .eq('id', userId)
            .single();

        if (profileError || !profile) return res.status(404).json({ error: 'User not found' });

        // 2. Fetch Gateway Settings
        const { data: settingsData, error: settingsError } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'deposit_gateway_settings')
            .single();

        if (settingsError || !settingsData) return res.status(500).json({ error: 'Payment settings not found' });

        const settings = settingsData.value;
        
        // Validate Gateway
        if (gateway === 'uddoktapay') {
            const apiKey = settings.uddoktapay?.api_key;
            const apiUrl = settings.uddoktapay?.api_url;

            if (!apiKey || !apiUrl) {
                return res.status(500).json({ error: 'UddoktaPay not configured correctly.' });
            }

            // 3. Create Pending Transaction in DB
            const { data: transaction, error: txError } = await supabase
                .from('transactions')
                .insert({
                    user_id: userId,
                    amount: amount,
                    type: 'DEPOSIT',
                    status: 'PENDING',
                    description: 'Online Deposit via UddoktaPay'
                })
                .select()
                .single();

            if (txError) return res.status(500).json({ error: 'Failed to create transaction record.' });

            // 4. Call UddoktaPay API
            const serverBaseUrl = process.env.SELF_URL || `https://${req.get('host')}`; // Best effort detection
            
            const payload = {
                full_name: profile.username || "Ludo Player",
                email: "user@example.com", // Email is required by UddoktaPay, using placeholder if not available
                amount: amount.toString(),
                metadata: {
                    user_id: userId,
                    transaction_id: transaction.id // Important: Link back to our DB
                },
                redirect_url: `${redirectBaseUrl}/#/wallet?payment=success`,
                cancel_url: `${redirectBaseUrl}/#/wallet?payment=cancel`,
                webhook_url: `${serverBaseUrl}/api/payment/webhook` // Server must be public
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'RT-UDDOKTAPAY-API-KEY': apiKey
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.status && data.payment_url) {
                return res.json({ payment_url: data.payment_url });
            } else {
                // Clean up pending transaction if API fails
                await supabase.from('transactions').update({ status: 'FAILED', description: 'API Init Failed: ' + (data.message || 'Unknown') }).eq('id', transaction.id);
                return res.status(400).json({ error: data.message || 'Failed to initiate payment with gateway.' });
            }
        } else if (gateway === 'paytm') {
             // Placeholder for Paytm implementation
             return res.status(501).json({ error: 'Paytm integration not fully implemented yet.' });
        } else {
            return res.status(400).json({ error: 'Invalid gateway selected.' });
        }

    } catch (e) {
        console.error('Payment Init Error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Webhook Handler
app.post('/api/payment/webhook', async (req, res) => {
    // Verify signature header if available: 'rt-uddoktapay-verify-signature'
    // For now, we trust the metadata transaction_id and status from the body
    
    const { status, metadata } = req.body;

    if (!metadata || !metadata.transaction_id) {
        return res.status(400).send('Invalid Webhook Payload');
    }

    console.log(`Webhook received for Tx: ${metadata.transaction_id}, Status: ${status}`);

    try {
        if (status === 'COMPLETED') {
            // Use the existing Postgres RPC function to process deposit securely
            // This handles double-checking status, adding balance, and referral bonuses
            const { data, error } = await supabase.rpc('process_deposit', {
                transaction_id_to_process: metadata.transaction_id,
                is_approved: true
            });

            if (error) {
                console.error("Webhook processing error:", error);
                return res.status(500).send('Error processing deposit');
            }
            console.log("Deposit processed:", data);
        } else {
             // Mark as failed/cancelled if needed
             await supabase
                .from('transactions')
                .update({ status: 'FAILED' })
                .eq('id', metadata.transaction_id)
                .eq('status', 'PENDING'); // Only update if still pending
        }

        res.send('OK');
    } catch (e) {
        console.error('Webhook Error:', e);
        res.status(500).send('Server Error');
    }
});


// --- WebSocket Server Logic ---
wss.on('connection', async (ws, req) => {
    const gameCode = req.url.slice(1).toUpperCase();
    
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

            if (tournament.status === 'COMPLETED') {
                ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'This game has already been played.' } }));
                ws.close(1011, 'Game already completed.');
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
                tournamentId: tournament.id,
            };

            const gameState = createNewGame(gameCode, gameOptions);
            games.set(gameCode, { state: gameState, clients: new Map(), turnTimer: null });
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
                 if (!existingPlayer) {
                    addPlayer(game.state, ws.userId, ws.userName);
                }

                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                broadcastGameState(gameCode);
                
                if (game.state.type === 'tournament' && game.state.players.length === game.state.max_players && game.state.gameStatus === 'Setup') {
                    setTimeout(async () => {
                        await startGame(game.state, null, supabase);
                        broadcastGameState(gameCode);
                        startTurnTimer(gameCode);
                    }, 10000);
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
                    await startGame(game.state, ws.userId, supabase);
                    startTurnTimer(gameCode);
                    break;
                case 'ROLL_DICE':
                    initiateRoll(game.state, ws.userId);
                    broadcastGameState(gameCode);
                    setTimeout(async () => {
                        const shouldAdvance = await completeRoll(game.state, ws.userId, supabase);
                        
                        // Always broadcast the result of the roll so the user can see it.
                        broadcastGameState(gameCode);

                        if (shouldAdvance) {
                            // If there are no movable pieces, wait a moment then advance the turn.
                            setTimeout(async () => {
                                await advanceTurn(game.state, supabase);
                                broadcastGameState(gameCode);
                                startTurnTimer(gameCode);
                            }, 1000); // Wait so player can see the roll
                        }
                    }, 1000);
                    return; // Return to prevent duplicate broadcast
                case 'MOVE_PIECE': 
                    await movePiece(game.state, ws.userId, payload.pieceId, supabase); 
                    startTurnTimer(gameCode); 
                    break;
                case 'LEAVE_GAME': 
                    await leaveGame(game.state, ws.userId, supabase); 
                    startTurnTimer(gameCode); 
                    break;
                case 'SEND_CHAT_MESSAGE': 
                    await sendChatMessage(game.state, ws.userId, payload.text, supabase); 
                    break;
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
            // Just remove the client, don't alter game state
            game.clients.delete(ws.userId);
            console.log(`Player ${ws.userName} client disconnected from ${gameCode}. Game state remains.`);
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

    const timerTick = async () => {
        if (!games.has(gameCode) || games.get(gameCode).state.gameStatus !== 'Playing') return;
        
        game.state.turnTimeLeft--;
        if (game.state.turnTimeLeft <= 0) {
            await handleMissedTurn(game.state, supabase);
            broadcastGameState(gameCode);
            if (game.state.gameStatus === 'Finished') {
                handleGameFinish(gameCode);
            } else {
                startTurnTimer(gameCode);
            }
        } else {
            game.turnTimer = setTimeout(timerTick, 1000);
            if(game.state.turnTimeLeft % 5 === 0) broadcastGameState(gameCode);
        }
    };
    game.turnTimer = setTimeout(timerTick, 1000);
}

async function archiveGameData(gameCode) {
    // This function is now OBSOLETE as data is saved in real-time.
    // Kept here to avoid breaking the call in handleGameFinish, but it does nothing.
    return;
}

async function handleGameFinish(gameCode) {
    const game = games.get(gameCode);
    if (!game) return;

    console.log(`Game ${gameCode} finished.`);
    clearTimeout(game.turnTimer);
    game.turnTimer = null;
    
    setTimeout(() => {
        games.delete(gameCode);
        console.log(`Game ${gameCode} removed from memory.`);
    }, 5000);
}

/************************************************************
 * Render Free Plan Keep-Alive (Self Ping)
 ************************************************************/

// 1. Add a /ping endpoint to keep server awake
app.get('/ping', (req, res) => res.send('pong'));

// 2. Self-Ping every 12 minutes to prevent Render sleeping
const SELF_URL = process.env.SELF_URL; 
const ENABLE_KEEP_ALIVE = process.env.ENABLE_KEEP_ALIVE === "true";

if (ENABLE_KEEP_ALIVE && SELF_URL) {
    console.log("🔄 Keep-Alive Enabled. Server will ping itself every 12 minutes:", SELF_URL);
    
    setInterval(async () => {
        try {
            await fetch(`${SELF_URL}/ping`);
            console.log("🔁 Self-Ping OK");
        } catch (err) {
            console.error("⚠️ Self-Ping Failed:", err.message);
        }
    }, 12 * 60 * 1000); // 12 minutes
}
// End render Keep-Alive (Self Ping)




server.listen(PORT, () => console.log(`Dream Ludo server listening on port ${PORT}`));
