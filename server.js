
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
// Requires SUPABASE_SERVICE_KEY for admin operations (bypassing RLS).
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: One or more Supabase environment variables are missing.");
    console.error("Ensure SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_KEY are set in your .env file.");
    process.exit(1);
}

// Initialize with the service key to bypass RLS for server operations.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const games = new Map(); // In-memory storage for active games

const app = express();

// CORS Middleware
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); 
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true })); 

const server = createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (req, res) => res.send('OK'));

// --- Payment Helper Logic ---

// Function to handle deposit completion securely on the server
async function processDepositServerSide(transactionId) {
    console.log(`Processing deposit for TxID: ${transactionId}`);
    try {
        // 1. Fetch Transaction
        const { data: tx, error: txError } = await supabase
            .from('transactions')
            .select('*')
            .eq('id', transactionId)
            .single();

        if (txError || !tx) {
            console.error(`Tx ${transactionId} not found or error:`, txError);
            return false;
        }
        
        if (tx.status === 'COMPLETED') {
            console.log(`Tx ${transactionId} already completed.`);
            return true; 
        }

        // 2. Update Transaction to COMPLETED first to prevent race conditions
        const { error: updateError } = await supabase
            .from('transactions')
            .update({ status: 'COMPLETED' })
            .eq('id', transactionId);
        
        if (updateError) {
             console.error(`Error updating Tx ${transactionId} status:`, updateError);
             throw updateError;
        }

        // 3. Fetch User Profile
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', tx.user_id)
            .single();

        if (!profile || profileError) {
             console.error(`Profile not found for user ${tx.user_id}`);
             return false;
        }

        // 4. Add Balance to User
        const depositAmount = Number(tx.amount);
        const newBalance = Number(profile.deposit_balance) + depositAmount;
        
        await supabase
            .from('profiles')
            .update({ deposit_balance: newBalance })
            .eq('id', tx.user_id);

        console.log(`Added ${depositAmount} to user ${tx.user_id}. New Balance: ${newBalance}`);

        // 5. Handle First Deposit Referrals
        // Check if this was the first completed deposit
        const { count } = await supabase
            .from('transactions')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', tx.user_id)
            .eq('type', 'DEPOSIT')
            .eq('status', 'COMPLETED');
        
        // count is 1 because we just updated this one to COMPLETED.
        const isFirstDeposit = count === 1; 

        if (isFirstDeposit && profile.referred_by) {
            console.log(`Processing referral for user ${tx.user_id} referred by ${profile.referred_by}`);
            
            // Fetch Settings
            const { data: settingsData } = await supabase
                .from('app_settings')
                .select('key, value')
                .in('key', ['referral_bonus_amount', 'referee_bonus_amount']);
            
            let referralBonus = 0;
            let refereeBonus = 0;
            if (settingsData) {
                const refSetting = settingsData.find(s => s.key === 'referral_bonus_amount');
                const refereeSetting = settingsData.find(s => s.key === 'referee_bonus_amount');
                if (refSetting?.value?.amount) referralBonus = Number(refSetting.value.amount);
                if (refereeSetting?.value?.amount) refereeBonus = Number(refereeSetting.value.amount);
            }

            // Award Referrer
            if (referralBonus > 0) {
                const { data: referrer } = await supabase.from('profiles').select('*').eq('id', profile.referred_by).single();
                if (referrer) {
                        const newRefBalance = Number(referrer.deposit_balance) + referralBonus;
                        await supabase.from('profiles').update({ deposit_balance: newRefBalance }).eq('id', profile.referred_by);
                        await supabase.from('transactions').insert({
                        user_id: profile.referred_by,
                        amount: referralBonus,
                        type: 'REFERRAL_BONUS',
                        status: 'COMPLETED',
                        description: `Referral bonus from ${profile.username}`,
                        source_user_id: tx.user_id
                        });
                        console.log(`Awarded referrer ${profile.referred_by} bonus: ${referralBonus}`);
                }
            }
            // Award Referee (Current User)
            if (refereeBonus > 0) {
                    // Refresh profile balance before adding bonus
                    const { data: refreshedProfile } = await supabase.from('profiles').select('deposit_balance').eq('id', tx.user_id).single();
                    const currentBal = Number(refreshedProfile.deposit_balance);
                    
                    await supabase.from('profiles').update({ deposit_balance: currentBal + refereeBonus }).eq('id', tx.user_id);
                    await supabase.from('transactions').insert({
                    user_id: tx.user_id,
                    amount: refereeBonus,
                    type: 'REFERRAL_BONUS',
                    status: 'COMPLETED',
                    description: 'Sign-up bonus for using a referral code.'
                    });
                    console.log(`Awarded referee ${tx.user_id} bonus: ${refereeBonus}`);
            }
        }
        return true;
    } catch (e) {
        console.error("Error processing deposit server side:", e);
        return false;
    }
}


// --- Payment Endpoints ---

const handleGatewayRedirect = (req, res, status) => {
    const frontendUrl = req.query.frontend_url;
    const transactionId = req.query.transaction_id;
    // UddoktaPay usually returns 'invoice_id' in the query params upon redirect
    const invoiceId = req.query.invoice_id;

    if (frontendUrl) {
        // Redirect using 303 to force GET method
        let redirectUrl = `${frontendUrl}/#/wallet?payment=${status}`;
        if (transactionId) redirectUrl += `&transaction_id=${transactionId}`;
        if (invoiceId) redirectUrl += `&invoice_id=${invoiceId}`;
        
        res.redirect(303, redirectUrl);
    } else {
        res.send(`Payment ${status}. Please close this window and return to the app.`);
    }
};

app.all('/api/payment/success', (req, res) => handleGatewayRedirect(req, res, 'success'));
app.all('/api/payment/cancel', (req, res) => handleGatewayRedirect(req, res, 'cancel'));

// Initialize Payment
app.post('/api/payment/init', async (req, res) => {
    const { userId, amount, gateway, redirectBaseUrl } = req.body;

    if (!userId || !amount || !redirectBaseUrl) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // 1. Fetch User
        const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('username, id, email') 
            .eq('id', userId)
            .single();

        if (profileError || !profile) return res.status(404).json({ error: 'User not found' });

        // 2. Fetch Settings
        const { data: settingsData, error: settingsError } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'deposit_gateway_settings')
            .single();

        if (settingsError || !settingsData) return res.status(500).json({ error: 'Payment settings not found' });
        const settings = settingsData.value;
        
        // 3. Create Pending Transaction
        const { data: transaction, error: txError } = await supabase
            .from('transactions')
            .insert({
                user_id: userId,
                amount: amount,
                type: 'DEPOSIT',
                status: 'PENDING',
                description: `Online Deposit via ${gateway || 'Gateway'}`
            })
            .select()
            .single();

        if (txError) return res.status(500).json({ error: 'Failed to create transaction record.' });

        // 4. Process Gateway
        if (gateway === 'uddoktapay') {
            const apiKey = settings.uddoktapay?.api_key;
            const apiUrl = settings.uddoktapay?.api_url;

            if (!apiKey || !apiUrl) return res.status(500).json({ error: 'UddoktaPay not configured.' });

            const serverBaseUrl = process.env.SELF_URL || `https://${req.get('host')}`; 
            const encodedFrontendUrl = encodeURIComponent(redirectBaseUrl);
            // Append transaction_id to the return URLs so we can identify it later
            const returnUrlParams = `frontend_url=${encodedFrontendUrl}&transaction_id=${transaction.id}`;
            
            const payload = {
                full_name: profile.username || "Ludo Player",
                email: profile.email || "user@dreamludo.com", 
                amount: amount.toString(),
                metadata: {
                    user_id: userId,
                    transaction_id: transaction.id 
                },
                redirect_url: `${serverBaseUrl}/api/payment/success?${returnUrlParams}`,
                cancel_url: `${serverBaseUrl}/api/payment/cancel?${returnUrlParams}`,
                webhook_url: `${serverBaseUrl}/api/payment/webhook` 
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.status && data.payment_url) {
                return res.json({ payment_url: data.payment_url });
            } else {
                await supabase.from('transactions').update({ status: 'FAILED' }).eq('id', transaction.id);
                return res.status(400).json({ error: data.message || 'Gateway Init Failed' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid or unimplemented gateway.' });
        }

    } catch (e) {
        console.error('Payment Init Error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Manual Verify Endpoint
app.post('/api/payment/verify', async (req, res) => {
    const { transactionId, invoiceId } = req.body;

    if (!transactionId || !invoiceId) {
        return res.status(400).json({ error: 'Missing transaction ID or invoice ID.' });
    }

    try {
        // 1. Get Settings for API Key
        const { data: settingsData } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'deposit_gateway_settings')
            .single();
        
        if (!settingsData) return res.status(500).json({ error: 'Server config error.' });
        
        const apiKey = settingsData.value?.uddoktapay?.api_key;
        const verifyUrl = "https://uddoktapay.com/api/verify-payment"; // Default endpoint

        if (!apiKey) return res.status(500).json({ error: 'Gateway not configured.' });

        // 2. Call Gateway Verify API
        const verifyPayload = { invoice_id: invoiceId };
        const response = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'RT-UDDOKTAPAY-API-KEY': apiKey 
            },
            body: JSON.stringify(verifyPayload)
        });

        const data = await response.json();

        // 3. Check status
        // UddoktaPay returns { status: true, message: "...", data: { status: "COMPLETED", ... } }
        if (data.status && (data.data?.status === 'COMPLETED' || data.data?.status === 'SUCCESS')) {
             // Success! Process the deposit.
             const success = await processDepositServerSide(transactionId);
             if (success) {
                 return res.json({ success: true, message: 'Payment verified and wallet updated.' });
             } else {
                 return res.status(500).json({ error: 'Payment verified but wallet update failed.' });
             }
        } else {
            return res.status(400).json({ error: 'Payment not completed or verification failed at gateway.' });
        }

    } catch (e) {
        console.error("Verify API Error:", e);
        return res.status(500).json({ error: e.message });
    }
});

// Webhook Handler
app.post('/api/payment/webhook', async (req, res) => {
    const { status, metadata } = req.body;

    const isSuccess = status === 'COMPLETED' || status === 'completed' || status === 'SUCCESS';

    if (!metadata || !metadata.transaction_id) {
        return res.status(400).send('Invalid Payload');
    }

    console.log(`Webhook: Tx ${metadata.transaction_id} Status: ${status}`);

    try {
        if (isSuccess) {
            await processDepositServerSide(metadata.transaction_id);
        } else {
             await supabase
                .from('transactions')
                .update({ status: 'FAILED' })
                .eq('id', metadata.transaction_id)
                .eq('status', 'PENDING'); 
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
                        broadcastGameState(gameCode);
                        if (shouldAdvance) {
                            setTimeout(async () => {
                                await advanceTurn(game.state, supabase);
                                broadcastGameState(gameCode);
                                startTurnTimer(gameCode);
                            }, 1000);
                        }
                    }, 1000);
                    return;
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
            game.clients.delete(ws.userId);
            console.log(`Player ${ws.userName} disconnected from ${gameCode}.`);
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

// Keep-Alive Logic
app.get('/ping', (req, res) => res.send('pong'));
const SELF_URL = process.env.SELF_URL; 
if (process.env.ENABLE_KEEP_ALIVE === "true" && SELF_URL) {
    setInterval(async () => {
        try { await fetch(`${SELF_URL}/ping`); } catch (err) { console.error("Self-Ping Failed:", err.message); }
    }, 12 * 60 * 1000);
}

server.listen(PORT, () => console.log(`Dream Ludo server listening on port ${PORT}`));
