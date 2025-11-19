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

        // 5. Handle Referral Bonuses (Server-Side Implementation)
        // Check if this is the FIRST completed deposit for this user
        const { count } = await supabase
            .from('transactions')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', tx.user_id)
            .eq('type', 'DEPOSIT')
            .eq('status', 'COMPLETED');

        // If count is 1, it means this is the first one (we just updated it to COMPLETED above)
        // If there were previous ones, count would be > 1
        if (count === 1 && profile.referred_by) {
            console.log(`First deposit detected for referred user ${tx.user_id}. Processing bonuses...`);
            
            // Fetch Bonus Settings
            const { data: refSettings } = await supabase
                .from('app_settings')
                .select('key, value')
                .in('key', ['referral_bonus_amount', 'referee_bonus_amount']);
            
            const getSetting = (key) => {
                const s = refSettings?.find(item => item.key === key);
                return s?.value?.amount || 0;
            };

            const referrerBonus = getSetting('referral_bonus_amount');
            const refereeBonus = getSetting('referee_bonus_amount');

            // Credit Referrer
            if (referrerBonus > 0) {
                const { data: referrerProfile } = await supabase.from('profiles').select('deposit_balance, username').eq('id', profile.referred_by).single();
                if (referrerProfile) {
                     await supabase.from('profiles').update({ 
                         deposit_balance: Number(referrerProfile.deposit_balance) + referrerBonus 
                     }).eq('id', profile.referred_by);
                     
                     await supabase.from('transactions').insert({
                         user_id: profile.referred_by,
                         amount: referrerBonus,
                         type: 'REFERRAL_BONUS',
                         status: 'COMPLETED',
                         description: `Referral bonus from ${profile.username}`,
                         source_user_id: tx.user_id
                     });
                     console.log(`Credited referrer ${profile.referred_by} with ${referrerBonus}`);
                }
            }

            // Credit Referee (The current user)
            if (refereeBonus > 0) {
                // Re-fetch profile to get latest balance
                const { data: updatedProfile } = await supabase.from('profiles').select('deposit_balance').eq('id', tx.user_id).single();
                
                await supabase.from('profiles').update({ 
                     deposit_balance: Number(updatedProfile.deposit_balance) + refereeBonus 
                }).eq('id', tx.user_id);

                await supabase.from('transactions').insert({
                    user_id: tx.user_id,
                    amount: refereeBonus,
                    type: 'REFERRAL_BONUS',
                    status: 'COMPLETED',
                    description: 'Sign-up bonus for using a referral code.'
                });
                console.log(`Credited referee ${tx.user_id} with ${refereeBonus}`);
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
    const frontendUrl = req.query.frontend_url || req.body.frontend_url;
    
    if (frontendUrl) {
        let redirectUrl = `${frontendUrl}/#/wallet?payment=${status}`;
        res.redirect(303, redirectUrl);
    } else {
        res.send(`Payment ${status}. Please close this window.`);
    }
};

async function logGatewayResponse(invoiceId, transactionId, data) {
    try {
        const { error } = await supabase.from('deposit_gateway_logs').insert({
            invoice_id: invoiceId,
            transaction_id: transactionId,
            gateway: 'uddoktapay',
            raw_response: data
        });
        if (error) console.warn('Failed to insert gateway log:', error.message);
    } catch (e) {
        console.warn('Exception logging gateway response:', e.message);
    }
}

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
            
            const settings = settingsData?.value?.uddoktapay;
            const apiKey = settings?.api_key;
            const apiUrl = settings?.api_url;

            if (apiKey && apiUrl) {
                let verifyUrl = apiUrl;
                if (verifyUrl.endsWith('/checkout-v2')) {
                    verifyUrl = verifyUrl.replace('/checkout-v2', '/verify-payment');
                } else if (verifyUrl.endsWith('/checkout-v2/')) {
                     verifyUrl = verifyUrl.replace('/checkout-v2/', '/verify-payment');
                } else {
                    verifyUrl = verifyUrl.replace(/\/$/, '') + '/verify-payment';
                }

                const response = await fetch(verifyUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                    body: JSON.stringify({ invoice_id: invoiceId })
                });
                
                const responseText = await response.text();
                let data;
                try {
                    data = JSON.parse(responseText);
                } catch (parseError) {
                    console.error("Failed to parse Gateway response as JSON:", responseText);
                }
                
                if (data) {
                    await logGatewayResponse(invoiceId, transactionId, data);
                    
                    // Flexible status check: supports root-level 'status' or nested 'data.status'
                    let paymentStatus = null;
                    if (typeof data.status === 'string') {
                        paymentStatus = data.status;
                    } else if (data.data && data.data.status) {
                         paymentStatus = data.data.status;
                    }

                    if (paymentStatus === 'COMPLETED' || paymentStatus === 'SUCCESS') {
                         await processDepositServerSide(transactionId);
                    } else {
                        console.warn("Payment verification failed or status not completed:", data);
                    }
                }
            }
        } catch (e) {
            console.error("Auto-verification exception:", e);
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
                webhook_url: `${serverBaseUrl}/api/payment/webhook`
            };

            try {
                 const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                    body: JSON.stringify(payload)
                });
                
                const responseText = await response.text();
                let data;
                try {
                    data = JSON.parse(responseText);
                } catch (e) {
                    console.error("Init Payment Parse Error. Body:", responseText);
                    return res.status(502).json({ error: 'Received invalid response from payment gateway.' });
                }
                
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
        
        const settings = settingsData?.value?.uddoktapay;
        const apiKey = settings?.api_key;
        const apiUrl = settings?.api_url;

        if (!apiKey || !apiUrl) return res.status(500).json({ error: 'Gateway configuration missing.' });

        let verifyUrl = apiUrl;
        if (verifyUrl.endsWith('/checkout-v2')) {
            verifyUrl = verifyUrl.replace('/checkout-v2', '/verify-payment');
        } else if (verifyUrl.endsWith('/checkout-v2/')) {
                verifyUrl = verifyUrl.replace('/checkout-v2/', '/verify-payment');
        } else {
            verifyUrl = verifyUrl.replace(/\/$/, '') + '/verify-payment';
        }
        
        try {
            const response = await fetch(verifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': apiKey },
                body: JSON.stringify({ invoice_id: invoiceId })
            });

            const responseText = await response.text();
            let data;
            try {
                data = JSON.parse(responseText);
            } catch (e) {
                console.error("Verify Response Parse Error:", responseText);
                return res.status(502).json({ error: 'Invalid response from gateway.' });
            }
            
            // Log the response to Supabase
            await logGatewayResponse(invoiceId, transactionId, data);

            // Flexible status check: supports root-level 'status' or nested 'data.status'
            let paymentStatus = null;
            if (typeof data.status === 'string') {
                paymentStatus = data.status;
            } else if (data.data && data.data.status) {
                 paymentStatus = data.data.status;
            }

            if (paymentStatus === 'COMPLETED' || paymentStatus === 'SUCCESS') {
                 const success = await processDepositServerSide(transactionId);
                 return res.json({ success: success, message: success ? 'Verified and Updated' : 'Verified but Database Update Failed' });
            } else {
                return res.status(400).json({ error: `Payment status is ${paymentStatus || 'Unknown'}.` });
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
                
                let game = games.get(gameCode);
                if (!game) {
                    const options = { hostId: ws.userId, hostName: ws.userName, type: 'manual' };
                    const gameState = createNewGame(gameCode, options);
                    game = { state: gameState, clients: new Map(), turnTimer: null };
                    games.set(gameCode, game);
                }

                game.clients.set(ws.userId, ws);

                if (!game.state.players.some(p => p.playerId === ws.userId)) {
                    addPlayer(game.state, ws.userId, ws.userName);
                }

                ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                ws.send(JSON.stringify({ type: 'GAME_STATE_UPDATE', payload: game.state }));
                broadcastGameState(gameCode);
                return;
            }

            if (!ws.userId) return ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Not authenticated.' } }));

            const game = games.get(gameCode);
            if (!game) return;

            switch (action) {
                case 'START_GAME': await startGame(game.state, ws.userId, supabase); break;
                case 'ROLL_DICE': 
                    initiateRoll(game.state, ws.userId);
                    broadcastGameState(gameCode);
                    setTimeout(async () => {
                        const rolledAgain = await completeRoll(game.state, ws.userId, supabase);
                        broadcastGameState(gameCode);
                        if (rolledAgain) {
                             setTimeout(async () => {
                                await handleMissedTurn(game.state, supabase);
                                broadcastGameState(gameCode);
                             }, 1000);
                        }
                    }, 500);
                    return;
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
            if (game.clients.size === 0) {
                setTimeout(() => {
                    if (game.clients.size === 0) {
                        games.delete(ws.gameCode);
                    }
                }, 60000);
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
