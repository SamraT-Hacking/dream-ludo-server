
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
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: One or more Supabase environment variables are missing.");
    console.error("Ensure SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_KEY are set in your .env file.");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const games = new Map();

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

// --- Helpers ---

function isValidUuid(id) {
    const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return typeof id === 'string' && regex.test(id);
}

async function processDepositServerSide(transactionId) {
    console.log(`Processing deposit for TxID: ${transactionId}`);
    
    if (!isValidUuid(transactionId)) {
        console.error(`Invalid UUID provided for deposit processing: ${transactionId}`);
        return false;
    }

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

        // 2. Update Transaction to COMPLETED
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

        // 5. Handle Referrals (Simplified logic for server-side)
        // Ideally, this should trigger a database function or replicate the logic from the SQL function `process_deposit`.
        // For robustness, we can try calling the existing RPC if we had admin context, but here we do direct DB updates.
        // We will skip complex referral logic here to keep this safe and simple, relying on the transaction completion.
        // If referral logic is critical here, it should be moved to a shared PL/pgSQL function that we can call via RPC.

        return true;
    } catch (e) {
        console.error("Error processing deposit server side:", e);
        return false;
    }
}


// --- Payment Endpoints ---

const handleGatewayRedirect = (req, res, status) => {
    const frontendUrl = req.query.frontend_url || req.body.frontend_url;
    
    if (frontendUrl) {
        let redirectUrl = `${frontendUrl}/#/wallet?payment=${status}`;
        res.redirect(303, redirectUrl);
    } else {
        res.send(`Payment ${status}. Please close this window.`);
    }
};

app.all('/api/payment/success', async (req, res) => {
    const frontendUrl = req.query.frontend_url || req.body.frontend_url;
    const transactionId = req.query.transaction_id || req.body.transaction_id;
    const invoiceId = req.query.invoice_id || req.body.invoice_id;

    // Auto-verify if invoice info is present
    if (invoiceId && transactionId && isValidUuid(transactionId)) {
        try {
             const { data: settingsData } = await supabase
                .from('app_settings')
                .select('value')
                .eq('key', 'deposit_gateway_settings')
                .single();
            
            const apiKey = settingsData?.value?.uddoktapay?.api_key;

            if (apiKey) {
                const verifyUrl = "https://uddoktapay.com/api/verify-payment";
                // Need to use fetch - usually available in Node 18+. If older node, ensure node-fetch is installed or use https module.
                // Assuming Node 18+ or fetch polyfill environment.
                const response = await fetch(verifyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                    body: JSON.stringify({ invoice_id: invoiceId })
                });
                const data = await response.json();

                if (data.status && (data.data?.status === 'COMPLETED' || data.data?.status === 'SUCCESS')) {
                     await processDepositServerSide(transactionId);
                }
            }
        } catch (e) {
            console.error("Auto-verification error on success redirect:", e);
        }
    }

    if (frontendUrl) {
        res.redirect(303, `${frontendUrl}/#/wallet?payment=success`);
    } else {
        res.send(`Payment Successful. You can close this window.`);
    }
});

app.all('/api/payment/cancel', (req, res) => handleGatewayRedirect(req, res, 'cancel'));

app.post('/api/payment/init', async (req, res) => {
    try {
        const { userId, amount, gateway, redirectBaseUrl, userEmail, userName } = req.body;
        
         if (!userId || !amount || !redirectBaseUrl) {
            return res.status(400).json({ error: 'Missing required fields: userId, amount, or redirectBaseUrl.' });
        }

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

        if (txError) return res.status(500).json({ error: 'Failed to create transaction in database.' });

        const { data: settingsData } = await supabase.from('app_settings').select('value').eq('key', 'deposit_gateway_settings').single();
        const settings = settingsData?.value;
        
        if (gateway === 'uddoktapay') {
             const apiKey = settings?.uddoktapay?.api_key;
             const apiUrl = settings?.uddoktapay?.api_url;
             if (!apiKey || !apiUrl) return res.status(500).json({ error: 'UddoktaPay is not configured in Admin Settings.' });
             
             // Determine server base URL. Prioritize env var, fallback to request host.
             const protocol = req.headers['x-forwarded-proto'] || 'http';
             const host = req.headers.host;
             const serverBaseUrl = process.env.SELF_URL || `${protocol}://${host}`;
             
             const returnUrlParams = `frontend_url=${encodeURIComponent(redirectBaseUrl)}&transaction_id=${transaction.id}`;
             
             const payload = {
                full_name: userName || "User",
                email: userEmail || "user@example.com",
                amount: amount.toString(),
                metadata: { user_id: userId, transaction_id: transaction.id },
                redirect_url: `${serverBaseUrl}/api/payment/success?${returnUrlParams}`,
                cancel_url: `${serverBaseUrl}/api/payment/cancel?${returnUrlParams}`,
                webhook_url: `${serverBaseUrl}/api/payment/webhook` // Optional if not using webhook
            };

            try {
                 const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                
                if (data.status && data.payment_url) {
                    return res.json({ payment_url: data.payment_url });
                } else {
                    return res.status(400).json({ error: data.message || 'Gateway returned an error.' });
                }
            } catch (fetchError) {
                console.error("UddoktaPay fetch error:", fetchError);
                 return res.status(500).json({ error: 'Failed to communicate with payment gateway.' });
            }
        }
        return res.status(400).json({ error: 'Invalid or unsupported gateway selected.' });

    } catch (e) {
        console.error('Payment Init Error:', e);
        res.status(500).json({ error: `Internal Server Error: ${e.message}` });
    }
});

app.post('/api/payment/verify', async (req, res) => {
    try {
        const { transactionId, invoiceId } = req.body;

        if (!transactionId || !invoiceId) {
            return res.status(400).json({ error: 'Missing transactionId or invoiceId.' });
        }
        
        // Check for "undefined" string specifically which can come from frontend bugs
        if (transactionId === 'undefined' || invoiceId === 'undefined') {
             return res.status(400).json({ error: 'Invalid ID format (undefined).' });
        }

        if (!isValidUuid(transactionId)) {
             return res.status(400).json({ error: 'Invalid Transaction ID format.' });
        }

        const { data: settingsData } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'deposit_gateway_settings')
            .single();
        
        const apiKey = settingsData?.value?.uddoktapay?.api_key;
        if (!apiKey) return res.status(500).json({ error: 'Gateway API Key not found in settings.' });

        // Call Gateway Verify API
        const verifyUrl = "https://uddoktapay.com/api/verify-payment";
        
        try {
            const response = await fetch(verifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                body: JSON.stringify({ invoice_id: invoiceId })
            });

            const data = await response.json();

            if (data.status && (data.data?.status === 'COMPLETED' || data.data?.status === 'SUCCESS')) {
                 const success = await processDepositServerSide(transactionId);
                 return res.json({ success: success, message: success ? 'Verified and Updated' : 'Verified but Database Update Failed' });
            } else {
                return res.status(400).json({ error: `Payment status is ${data.data?.status || 'Unknown'}.` });
            }
        } catch (fetchError) {
            console.error("UddoktaPay Verify fetch error:", fetchError);
            return res.status(500).json({ error: 'Failed to reach payment gateway for verification.' });
        }

    } catch (e) {
        console.error("Verify Endpoint Error:", e);
        if (!res.headersSent) {
            res.status(500).json({ error: `Server Error: ${e.message}` });
        }
    }
});

// --- WebSocket Server Logic ---
wss.on('connection', (ws, req) => {
    const gameCode = req.url.slice(1).toUpperCase();
    
    // Allow connection even if game doesn't exist yet, logic will handle creation or rejection
    // Ideally, we should check if the gameCode is valid or pre-created.
    // For simplicity in this unified server, we lazily create the map entry if it's a valid flow.
    
    // However, to prevent memory leaks from random URL connections, 
    // we should ideally only allow connecting to existing games or authorized creations.
    // Here we'll allow it but clean up quickly if empty.

    ws.on('message', async (message) => {
        try {
            const { action, payload } = JSON.parse(message);

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
                
                // Get or create game room
                let game = games.get(gameCode);
                if (!game) {
                    // If game doesn't exist in memory, try to fetch from DB to see if it's a valid tournament
                    // This is a simplification. In a real app, we'd load state from DB.
                    // For now, we create a new empty game state if it's the first user.
                    const options = { hostId: ws.userId, hostName: ws.userName, type: 'manual' };
                    const gameState = createNewGame(gameCode, options);
                    game = { state: gameState, clients: new Map(), turnTimer: null };
                    games.set(gameCode, game);
                }

                game.clients.set(ws.userId, ws);

                // Add player if not already in state
                if (!game.state.players.some(p => p.playerId === ws.userId)) {
                    addPlayer(game.state, ws.userId, ws.userName);
                }

                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                // Send immediate state update
                ws.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', payload: game.state }));
                
                // Broadcast join
                broadcastGameState(gameCode);
                return;
            }

            if (!ws.userId) return ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Not authenticated.' } }));

            const game = games.get(gameCode);
            if (!game) return;

            // Basic rate limiting could go here

            switch (action) {
                case 'START_GAME': await startGame(game.state, ws.userId, supabase); break;
                case 'ROLL_DICE': 
                    initiateRoll(game.state, ws.userId);
                    broadcastGameState(gameCode);
                    // Simulate roll delay
                    setTimeout(async () => {
                        const rolledAgain = await completeRoll(game.state, ws.userId, supabase);
                        broadcastGameState(gameCode);
                        if (rolledAgain) {
                            // If no moves possible, auto advance after short delay
                             setTimeout(async () => {
                                await handleMissedTurn(game.state, supabase); // Or just advanceTurn
                                broadcastGameState(gameCode);
                             }, 1000);
                        }
                    }, 500);
                    return; // Special handling for async roll
                case 'MOVE_PIECE': await movePiece(game.state, ws.userId, payload.pieceId, supabase); break;
                case 'LEAVE_GAME': await leaveGame(game.state, ws.userId, supabase); break;
                case 'SEND_CHAT_MESSAGE': await sendChatMessage(game.state, ws.userId, payload.text, supabase); break;
            }

            broadcastGameState(gameCode);

        } catch (err) {
            console.error('Error processing message:', err);
            ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'An internal server error occurred.' } }));
        }
    });

    ws.on('close', () => {
        if (!ws.gameCode) return;
        const game = games.get(ws.gameCode);
        if (game && ws.userId) {
            game.clients.delete(ws.userId);
            // Optional: Mark as disconnected in game state immediately or wait for reconnect?
            // For Ludo, usually we just leave them as "inactive" until they timeout.
            // But if they explicitly closed, we might want to notify.
            
            if (game.clients.size === 0) {
                // Clean up empty games after a timeout to allow reconnects
                setTimeout(() => {
                    if (game.clients.size === 0) {
                        games.delete(ws.gameCode);
                    }
                }, 60000); // 1 minute cleanup
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
