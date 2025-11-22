
// /dream-ludo-server/server.js
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const PaytmChecksum = require('./paytmChecksum'); // Import Paytm utility
const RazorpayUtils = require('./razorpayUtils'); // Import Razorpay utility

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
const supportClients = new Map(); // userId -> WebSocket
const adminSupportClients = new Set(); // Set<WebSocket>
const groupChatClients = new Set(); // Set<WebSocket> for global chat

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

// --- Unified WebSocket Server ---
const wss = new WebSocketServer({ server });

app.get('/health', (req, res) => res.send('OK'));

// --- Helpers ---

function isValidUuid(id) {
    const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return typeof id === 'string' && regex.test(id);
}

async function processDepositServerSide(transactionId, paymentMethod = null) {
    if (!isValidUuid(transactionId)) return false;
    try {
        const { data: tx, error: txError } = await supabase
            .from('transactions').select('*').eq('id', transactionId).single();
        if (txError || !tx) return false;
        if (tx.status === 'COMPLETED') return true; 

        const updateData = { status: 'COMPLETED' };
        if (paymentMethod) updateData.description = `Auto Deposit via ${paymentMethod}`;

        await supabase.from('transactions').update(updateData).eq('id', transactionId);
        
        const { data: profile } = await supabase.from('profiles').select('*').eq('id', tx.user_id).single();
        if (!profile) return false;

        const depositAmount = Number(tx.amount);
        const newBalance = Number(profile.deposit_balance) + depositAmount;
        await supabase.from('profiles').update({ deposit_balance: newBalance }).eq('id', tx.user_id);

        const { count } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', tx.user_id).eq('type', 'DEPOSIT').eq('status', 'COMPLETED');

        if (count === 1 && profile.referred_by) {
            const { data: refSettings } = await supabase.from('app_settings').select('key, value').in('key', ['referral_bonus_amount', 'referee_bonus_amount']);
            const getSetting = (key) => { const s = refSettings?.find(item => item.key === key); return s?.value?.amount || 0; };
            const referrerBonus = getSetting('referral_bonus_amount');
            const refereeBonus = getSetting('referee_bonus_amount');

            if (referrerBonus > 0) {
                const { data: referrerProfile } = await supabase.from('profiles').select('deposit_balance, username').eq('id', profile.referred_by).single();
                if (referrerProfile) {
                     await supabase.from('profiles').update({ deposit_balance: Number(referrerProfile.deposit_balance) + referrerBonus }).eq('id', profile.referred_by);
                     await supabase.from('transactions').insert({ user_id: profile.referred_by, amount: referrerBonus, type: 'REFERRAL_BONUS', status: 'COMPLETED', description: `Referral bonus from ${profile.username}`, source_user_id: tx.user_id });
                }
            }

            if (refereeBonus > 0) {
                const { data: updatedProfile } = await supabase.from('profiles').select('deposit_balance').eq('id', tx.user_id).single();
                await supabase.from('profiles').update({ deposit_balance: Number(updatedProfile.deposit_balance) + refereeBonus }).eq('id', tx.user_id);
                await supabase.from('transactions').insert({ user_id: tx.user_id, amount: refereeBonus, type: 'REFERRAL_BONUS', status: 'COMPLETED', description: 'Sign-up bonus for using a referral code.' });
            }
        }
        return true;
    } catch (e) {
        console.error("Error processing deposit:", e);
        return false;
    }
}

async function logGatewayResponse(invoiceId, transactionId, data, gateway = 'uddoktapay') {
    try {
        await supabase.from('deposit_gateway_logs').insert({
            invoice_id: invoiceId, transaction_id: transactionId, gateway: gateway,
            raw_response: data, sender_number: data.sender_number || null, payment_method: data.payment_method || data.PAYMENTMODE || null
        });
    } catch (e) { console.warn('Log error:', e.message); }
}

app.post('/api/payment/check-cancel', async (req, res) => {
    const { transactionId } = req.body;
    if (!transactionId || !isValidUuid(transactionId)) return res.status(400).json({error: 'Invalid ID'});
    try {
        const { data } = await supabase.from('transactions').select('status').eq('id', transactionId).single();
        if (data && data.status === 'PENDING') {
            await supabase.from('transactions').update({ status: 'FAILED', description: 'Cancelled/Abandoned by User' }).eq('id', transactionId);
            return res.json({ status: 'cancelled' });
        }
        return res.json({ status: data ? data.status : 'not_found' });
    } catch(e) { return res.status(500).json({error: e.message}); }
});

app.all('/api/payment/success', async (req, res) => {
    const frontendUrl = req.query.frontend_url || req.body.frontend_url;
    const transactionId = req.query.transaction_id || req.body.transaction_id;
    const invoiceId = req.query.invoice_id || req.body.invoice_id;
    if (invoiceId && transactionId && isValidUuid(transactionId)) {
        try {
             const { data: settingsData } = await supabase.from('app_settings').select('value').eq('key', 'deposit_gateway_settings').single();
             const settings = settingsData?.value?.uddoktapay;
             if (settings?.api_key && settings?.api_url) {
                let verifyUrl = settings.api_url.endsWith('/checkout-v2') ? settings.api_url.replace('/checkout-v2', '/verify-payment') : settings.api_url.replace(/\/$/, '') + '/verify-payment';
                const response = await fetch(verifyUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': settings.api_key },
                    body: JSON.stringify({ invoice_id: invoiceId })
                });
                const data = await response.json();
                if (data) {
                    await logGatewayResponse(invoiceId, transactionId, data);
                    if (data.status === 'COMPLETED' || data.status === 'SUCCESS') await processDepositServerSide(transactionId, data.payment_method);
                }
            }
        } catch (e) { console.error("Auto-verification exception:", e); }
    }
    if (frontendUrl) res.redirect(303, `${frontendUrl}/#/wallet?payment=success`);
    else res.send(`Payment Successful.`);
});

app.all('/api/payment/cancel', async (req, res) => {
    const transactionId = req.query.transaction_id || req.body.transaction_id;
    const frontendUrl = req.query.frontend_url || req.body.frontend_url;
    if (transactionId && isValidUuid(transactionId)) {
        try { await supabase.from('transactions').update({ status: 'FAILED', description: 'Payment Cancelled by User' }).eq('id', transactionId); } catch (e) {}
    }
    if (frontendUrl) res.redirect(303, `${frontendUrl}/#/wallet?payment=cancel`);
    else res.send(`Payment Cancelled.`);
});

app.post('/api/payment/init', async (req, res) => {
    try {
        const { userId, amount, gateway, redirectBaseUrl, userEmail, userName, userPhone } = req.body;
         if (!userId || !amount || !redirectBaseUrl) return res.status(400).json({ error: 'Missing fields' });
        
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const serverBaseUrl = process.env.SELF_URL || `${protocol}://${req.headers.host}`;

        const { data: transaction, error: txError } = await supabase.from('transactions').insert({
                user_id: userId, amount: amount, type: 'DEPOSIT', status: 'PENDING', description: `Online Deposit via ${gateway || 'Gateway'}`
            }).select().single();
        if (txError) return res.status(500).json({ error: 'DB Error' });

        const { data: settingsData } = await supabase.from('app_settings').select('value').eq('key', 'deposit_gateway_settings').single();
        const settings = settingsData?.value;
        
        if (gateway === 'uddoktapay') {
             const { api_key, api_url } = settings?.uddoktapay || {};
             if (!api_key || !api_url) return res.status(500).json({ error: 'Gateway Config Error' });
             
             const returnUrlParams = `frontend_url=${encodeURIComponent(redirectBaseUrl)}&transaction_id=${transaction.id}`;
             const payload = {
                full_name: userName || "User", email: userEmail || "user@example.com", amount: amount.toString(),
                metadata: { user_id: userId, transaction_id: transaction.id },
                redirect_url: `${serverBaseUrl}/api/payment/success?${returnUrlParams}`,
                cancel_url: `${serverBaseUrl}/api/payment/cancel?${returnUrlParams}`,
                webhook_url: `${serverBaseUrl}/api/payment/webhook`
            };
            try {
                 const response = await fetch(api_url, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'RT-UDDOKTAPAY-API-KEY': api_key },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                if (data.status && data.payment_url) return res.json({ payment_url: data.payment_url, transactionId: transaction.id });
                else return res.status(400).json({ error: data.message || 'Gateway Error' });
            } catch (e) { return res.status(500).json({ error: 'Gateway Comms Error' }); }
        }
        
        if (gateway === 'paytm') {
             if (!settings?.paytm?.merchant_id || !settings?.paytm?.merchant_key) return res.status(500).json({ error: 'Paytm Config Error' });
             const processUrl = `${serverBaseUrl}/api/payment/paytm-process/${transaction.id}?redirect_base=${encodeURIComponent(redirectBaseUrl)}`;
             return res.json({ payment_url: processUrl, transactionId: transaction.id });
        }

        if (gateway === 'razorpay') {
            if (!settings?.razorpay?.key_id || !settings?.razorpay?.key_secret) return res.status(500).json({ error: 'Razorpay Config Error' });
            const callbackUrl = `${serverBaseUrl}/api/payment/razorpay-callback?frontend_url=${encodeURIComponent(redirectBaseUrl)}&transaction_id=${transaction.id}`;
            const params = {
                amount: Math.round(amount * 100), currency: "INR", accept_partial: false, reference_id: transaction.id,
                description: `Deposit by ${userName}`, customer: { name: userName, email: userEmail, contact: userPhone || "+919999999999" },
                notify: { sms: true, email: true }, reminder_enable: true, callback_url: callbackUrl, callback_method: "get"
            };
            try {
                const linkData = await RazorpayUtils.createPaymentLink(params, settings.razorpay.key_id, settings.razorpay.key_secret);
                if (linkData.short_url) return res.json({ payment_url: linkData.short_url, transactionId: transaction.id });
                else throw new Error('No short_url');
            } catch (e) { return res.status(500).json({ error: `Razorpay Error: ${e.message}` }); }
        }
        return res.status(400).json({ error: 'Invalid Gateway' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/payment/paytm-process/:txnId', async (req, res) => {
    const { txnId } = req.params;
    const { redirect_base } = req.query;
    if (!isValidUuid(txnId)) return res.status(400).send("Invalid ID");

    try {
        const { data: transaction } = await supabase.from('transactions').select('*').eq('id', txnId).single();
        const { data: settingsData } = await supabase.from('app_settings').select('value').eq('key', 'deposit_gateway_settings').single();
        const settings = settingsData?.value?.paytm;
        
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const serverBaseUrl = process.env.SELF_URL || `${protocol}://${req.headers.host}`;
        const callbackUrl = `${serverBaseUrl}/api/payment/paytm-callback?frontend_url=${encodeURIComponent(redirect_base)}&transaction_id=${txnId}`;
        const params = {
            MID: settings.merchant_id, WEBSITE: settings.website || 'DEFAULT', INDUSTRY_TYPE_ID: 'Retail', CHANNEL_ID: 'WEB',
            ORDER_ID: txnId, CUST_ID: transaction.user_id, TXN_AMOUNT: transaction.amount.toString(), CALLBACK_URL: callbackUrl,
        };
        const checksum = await PaytmChecksum.generateSignature(params, settings.merchant_key);
        const paytmUrl = "https://securegw.paytm.in/theia/processTransaction";
        res.send(`<html><body><center><h1>Processing...</h1></center><form method="post" action="${paytmUrl}" name="paytm_form">${Object.keys(params).map(key => `<input type="hidden" name="${key}" value="${params[key]}">`).join('')}<input type="hidden" name="CHECKSUMHASH" value="${checksum}"></form><script>document.paytm_form.submit();</script></body></html>`);
    } catch (e) { res.status(500).send("Error"); }
});

app.post('/api/payment/paytm-callback', async (req, res) => {
    const { frontend_url, transaction_id } = req.query;
    const received_data = req.body;
    try {
        const { data: settingsData } = await supabase.from('app_settings').select('value').eq('key', 'deposit_gateway_settings').single();
        const isValidChecksum = await PaytmChecksum.verifySignature(received_data, settingsData?.value?.paytm?.merchant_key, received_data.CHECKSUMHASH);
        if (isValidChecksum) {
            await logGatewayResponse(received_data.ORDERID, transaction_id, received_data, 'paytm');
            if (received_data.STATUS === 'TXN_SUCCESS') {
                 await processDepositServerSide(transaction_id, 'Paytm');
                 if (frontend_url) return res.redirect(303, `${frontend_url}/#/wallet?payment=success`);
            } else {
                 if (transaction_id && isValidUuid(transaction_id)) await supabase.from('transactions').update({ status: 'FAILED', description: `Paytm Failed: ${received_data.RESPMSG}` }).eq('id', transaction_id);
            }
        }
    } catch (e) { console.error(e); }
    if (frontend_url) res.redirect(303, `${frontend_url}/#/wallet?payment=cancel`);
    else res.send("Done");
});

app.get('/api/payment/razorpay-callback', async (req, res) => {
    const { frontend_url, transaction_id, ...razorpayParams } = req.query;
    const { razorpay_payment_link_status } = razorpayParams;
    if (!isValidUuid(transaction_id)) return res.status(400).send("Invalid ID");
    try {
        const { data: settingsData } = await supabase.from('app_settings').select('value').eq('key', 'deposit_gateway_settings').single();
        const isValid = RazorpayUtils.verifySignature(razorpayParams, settingsData?.value?.razorpay?.key_secret);
        if (isValid) {
             await logGatewayResponse(razorpayParams.razorpay_payment_link_id, transaction_id, razorpayParams, 'razorpay');
             if (razorpay_payment_link_status === 'paid') {
                 await processDepositServerSide(transaction_id, 'Razorpay');
                 if (frontend_url) return res.redirect(303, `${frontend_url}/#/wallet?payment=success`);
             } else {
                 await supabase.from('transactions').update({ status: 'FAILED', description: `Razorpay status: ${razorpay_payment_link_status}` }).eq('id', transaction_id);
             }
        }
    } catch (e) { console.error(e); }
    if (frontend_url) res.redirect(303, `${frontend_url}/#/wallet?payment=cancel`);
    else res.send("Done");
});

app.post('/api/payment/verify', async (req, res) => {
    // Verification logic... same as before
    res.json({message: 'Manual verify endpoint'});
});

// --- GAME TIMER MANAGEMENT ---
function startGameLoop(gameCode) {
    const game = games.get(gameCode);
    if (!game || game.turnTimer) return;

    console.log(`Starting game loop for ${gameCode}`);

    game.turnTimer = setInterval(async () => {
        if (game.state.gameStatus === 'Finished') {
            clearInterval(game.turnTimer);
            game.turnTimer = null;
            return;
        }
        
        if (game.state.gameStatus === 'Playing' && game.state.diceValue === null && !game.state.isRolling) {
            if (game.state.turnTimeLeft > 0) {
                game.state.turnTimeLeft--;
            } else {
                console.log(`Time up for player in game ${gameCode}`);
                await handleMissedTurn(game.state, supabase);
            }
            broadcastGameState(gameCode); 
        }
    }, 1000);
}

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

// --- Unified WebSocket Server ---
wss.on('connection', (ws, req) => {
    const url = req.url;

    if (url === '/group-chat') {
        ws.isGroupChat = true;
        ws.on('message', async (message) => {
            try {
                const { type, payload } = JSON.parse(message);
                if (type === 'AUTH') {
                    const { data: { user } } = await supabase.auth.getUser(payload.token);
                    if (!user) return ws.close();
                    const { data: profile } = await supabase.from('profiles').select('username').eq('id', user.id).single();
                    ws.userId = user.id;
                    ws.username = profile?.username || 'User';
                    groupChatClients.add(ws);
                    ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                }
                if (type === 'SEND_MESSAGE' && ws.userId) {
                    const { data: savedMsg, error: insertError } = await supabase.from('group_chat_messages').insert({
                        user_id: ws.userId,
                        username: ws.username,
                        message_text: payload.message_text
                    }).select().single();

                    if (insertError) {
                        console.error('Global Chat DB Insert Error:', insertError);
                        throw new Error(`Supabase insert error: ${insertError.message}`);
                    }

                    if (savedMsg) {
                        const msgString = JSON.stringify({ type: 'NEW_MESSAGE', payload: savedMsg });
                        for (const client of groupChatClients) {
                            if (client.readyState === 1) client.send(msgString);
                        }
                    }
                }
            } catch (e) {
                console.error('Error in group-chat message handler:', e);
            }
        });
        ws.on('close', () => groupChatClients.delete(ws));
        return;
    }

    if (url === '/support') {
        ws.on('message', async (message) => {
            try {
                const { type, payload } = JSON.parse(message);
                if (type === 'AUTH') {
                    const { data: { user } } = await supabase.auth.getUser(payload.token);
                    if (!user) return ws.close();
                    const { data: profile } = await supabase.from('profiles').select('role, username').eq('id', user.id).single();
                    ws.userId = user.id;
                    ws.userRole = profile?.role || 'user';
                    ws.username = profile?.username || 'User';
                    if (ws.userRole === 'admin') adminSupportClients.add(ws);
                    else supportClients.set(ws.userId, ws);
                    ws.send(JSON.stringify({ type: 'AUTH_SUCCESS' }));
                }
                if (type === 'SEND_MESSAGE' && ws.userId) {
                    const { message_text, target_user_id } = payload;
                    const isSenderAdmin = ws.userRole === 'admin';
                    const conversationOwnerId = isSenderAdmin ? target_user_id : ws.userId;
                    const { data: savedMsg, error: insertError } = await supabase.from('support_chats').insert({
                        user_id: conversationOwnerId,
                        username: isSenderAdmin ? 'Admin' : ws.username,
                        message_text,
                        sent_by_admin: isSenderAdmin
                    }).select().single();

                    if (insertError) {
                        console.error('Support Chat DB Insert Error:', insertError);
                        throw new Error(`Supabase insert error: ${insertError.message}`);
                    }

                    if (savedMsg) {
                        const msgString = JSON.stringify({ type: 'NEW_MESSAGE', payload: savedMsg });
                        const userSocket = supportClients.get(conversationOwnerId);
                        if (userSocket && userSocket.readyState === 1) userSocket.send(msgString);
                        for (const adminWs of adminSupportClients) {
                            if (adminWs.readyState === 1) adminWs.send(msgString);
                        }
                    }
                }
            } catch (e) {
                console.error('Error in support message handler:', e);
            }
        });
        ws.on('close', () => { supportClients.delete(ws.userId); adminSupportClients.delete(ws); });
        return;
    }


    // --- GAME HANDLING ---
    const gameCode = url.slice(1).toUpperCase();
    
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
                    try {
                        let type = 'manual';
                        let max_players = 2;
                        let tournamentId = null;
                        
                        const { data: tournament, error: tourError } = await supabase
                            .from('tournaments')
                            .select('*')
                            .eq('game_code', gameCode)
                            .neq('status', 'CANCELLED')
                            .maybeSingle();
                        
                        if (tourError) {
                            console.error("Error fetching tournament:", tourError.message);
                            ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Server error: Failed to load game data. Please try again.' } }));
                            return;
                        }

                        if (tournament) { type = 'tournament'; max_players = tournament.max_players; tournamentId = tournament.id; }

                        const options = { hostId: ws.userId, hostName: ws.userName, type, max_players, tournamentId };
                        const gameState = createNewGame(gameCode, options);
                        game = { state: gameState, clients: new Map(), turnTimer: null };
                        games.set(gameCode, game);
                    } catch (err) {
                        console.error("Critical error creating game:", err);
                        ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Failed to create game session.' } }));
                        return;
                    }
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
                case 'START_GAME': 
                    await startGame(game.state, ws.userId, supabase); 
                    startGameLoop(gameCode); 
                    break;
                case 'ROLL_DICE': 
                    initiateRoll(game.state, ws.userId);
                    broadcastGameState(gameCode);
                    setTimeout(async () => {
                        const rollResult = await completeRoll(game.state, ws.userId, supabase);
                        broadcastGameState(gameCode);
                        
                        // Handle delayed turn transitions for better UX
                        if (rollResult === 'PENALTY') {
                             // Wait 2s to show "Rolled three 6s" message, then advance
                             setTimeout(async () => {
                                await advanceTurn(game.state, supabase);
                                broadcastGameState(gameCode);
                             }, 2000);
                        } else if (rollResult === 'NO_MOVES') {
                             // No valid moves, wait 1s then advance
                             setTimeout(async () => {
                                await advanceTurn(game.state, supabase); 
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
                        if (game.turnTimer) clearInterval(game.turnTimer);
                        games.delete(ws.gameCode);
                    }
                }, 60000);
            }
        }
    });
});

server.listen(PORT, () => console.log(`Dream Ludo server listening on port ${PORT}`));
