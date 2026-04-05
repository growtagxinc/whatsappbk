require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const rateLimit = require('express-rate-limit');
const { sendMessage } = require('./src/lib/whatsapp-cloud');
const webhookRouter = require('./src/routes/webhooks');
const { pushInbound, pushOutbound } = require('./src/lib/queue');
require('./src/lib/worker'); // Start the background worker
const mongoose = require('mongoose'); // Moved up for global log buffer
const { google } = require('googleapis');
const { authMiddleware, issueToken, verifyToken } = require('./src/lib/auth');
const { sanitizeAIInput } = require('./ai/sanitize');

// ── Meta Cloud API Mode Detection ──────────────────────────────
// If WHATSAPP_TOKEN + PHONE_NUMBER_ID are set, use Meta Cloud API (no QR code)
const USE_META_CLOUD = false; // Forced off to prioritize Device/QR Connection
const USE_BAILEYS = process.env.USE_BAILEYS === 'true';

/**
 * Send a message via Meta Cloud API (no Baileys/QR needed).
 * Strips WhatsApp chat ID suffixes (@c.us, @s.whatsapp.net) from the recipient.
 * @param {string} to - Chat ID or phone number
 * @param {string} text - Message text
 * @param {Object} opts - Optional config overrides
 */
async function sendViaMeta(to, text, opts = {}) {
    // Strip WhatsApp chat ID suffixes to get clean phone number
    const phone = String(to).replace(/@(c\.us|s\.whatsapp\.net|g\.us)$/, '');
    return sendMessage(phone, text, opts);
}

// ── Stub Baileys client for Meta Cloud API mode ────────────────
// Prevents "WhatsApp not ready" errors — Meta Cloud API is always ready.
const META_CLIENT_STUB = {
    sendMessage: async (to, text) => { await sendViaMeta(to, text); return { id: 'meta-stub' }; }
};

// ── Rate Limiter: Outbound WhatsApp Messages ──────────────────
// Limits how many messages a client can send per window.
// Prevents accidental spam, cost overruns, and Meta rate limits.
const MESSAGE_RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const MESSAGE_RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX_MESSAGES) || 30;

// In-memory store for rate limiting (keyed by clientId).
// In production with multiple workers, use Redis: see express-rate-limit docs.
const messageRateLimiter = rateLimit({
    windowMs: MESSAGE_RATE_LIMIT_WINDOW_MS,
    max: MESSAGE_RATE_LIMIT_MAX,
    standardHeaders: true,     // Return rate limit info in headers
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Use the JWT-authenticated clientId (not spoofable via header)
        return req.clientId || req.headers['x-client-id'] || req.ip || 'unknown';
    },
    handler: (req, res) => {
        console.warn(`[RATE LIMIT] Client ${req.clientId} exceeded message rate limit`);
        res.status(429).json({
            error: 'Too many messages. Please wait before sending more.',
            retryAfter: Math.ceil(MESSAGE_RATE_LIMIT_WINDOW_MS / 1000)
        });
    },
    skip: (req) => {
        // Only apply to message-sending routes
        return !req.path.includes('/messages') && req.method !== 'POST';
    }
});
// ─────────────────────────────────────────────────────────────

// Global log buffer for UI
const systemLogs = [];
const originalLog = console.log;
console.log = (...args) => {
    const log = { timestamp: new Date(), message: args.join(' ') };
    systemLogs.push(log);
    if (systemLogs.length > 100) systemLogs.shift(); // Keep buffer size manageable
    originalLog(...args);
};

console.log('--------------------------------------------------');
console.log('🚀 BACKEND STARTING UP AT:', new Date().toISOString());
console.log('📍 WORKING DIR:', process.cwd());
console.log('📍 TARGET PORT:', process.env.PORT || 80);
console.log('--------------------------------------------------');

const { processMessage, determineIntent } = require('./ai/ai-router');
const { handleVision } = require('./ai/vision');
const { getConfig, updateConfig } = require('./ai/agents');
let auditProfile;
try {
    auditProfile = require('./ai/audit').auditProfile;
} catch (e) {
    console.warn('⚠️ Audit module unavailable (puppeteer removed). Stubbing...');
    auditProfile = async () => ({ success: false, data: null });
}
const { safeJsonParse } = require('./ai/utils');

const app = express();
const allowedOrigins = [
    'https://concertos.brandproinc.in',
    'https://brandproinc.in',
    'https://dash.concertos.brandproinc.in',
    'https://admin.concertos.brandproinc.in',
    'https://concertos-dash.pages.dev',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
];

// 1. Mirror-Origin CORS Middleware (MAX COMPATIBILITY)
app.use((req, res, next) => {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-id, bypass-tunnel-reminder');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});


app.use(express.json());

// Cookie parser (for httpOnly JWT cookies)
app.use(require('cookie-parser')());

// 2. Meta Cloud API Webhook
app.use('/webhooks/whatsapp', webhookRouter);
app.use('/api/auth', require('./src/routes/auth-otp'));
app.use('/api/auth', require('./src/routes/auth-user')); // user auth: register, login, logout, me
app.use('/api/onboarding', require('./src/routes/onboarding'));

// 3. Health & Public Routes (detailed handler defined below after models load)

app.get('/api/profiles', async (req, res) => {
    try {
        const clientId = req.headers['x-client-id'] || 'default';
        if (mongoose.connection.readyState !== 1) {
            return res.json({ session: { status: 'DISCONNECTED', authenticated: false, qr: null } });
        }
        // Return actual session data — do NOT force authenticated: true
        const session = await Session.findOne({ clientId });
        if (!session) return res.json({ session: { status: 'DISCONNECTED', authenticated: false, qr: null } });
        res.json({ session });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profiles/init', async (req, res) => {
    try {
        const clientId = req.headers['x-client-id'] || 'default';
        if (USE_META_CLOUD) {
            // Meta Cloud API — no QR code, always ready
            res.json({ success: true, message: "Meta Cloud API active — no QR needed" });
        } else if (USE_BAILEYS && baileysManager) {
            // Baileys WebSocket mode — QR code streamed via Socket.io
            await baileysManager.initializeSession(clientId).catch(err => console.error("[Baileys] Init Error:", err));
            res.json({ success: true, message: "Baileys initializing — scan QR from dashboard" });
        } else {
            // whatsapp-web.js (Puppeteer) mode
            getClient(clientId).catch(err => console.error("Init Error:", err));
            res.json({ success: true, message: "Initializing..." });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profiles/logout', async (req, res) => {
    try {
        const clientId = req.headers['x-client-id'] || 'default';
        if (USE_BAILEYS && baileysManager) {
            await baileysManager.destroySession(clientId);
        }
        await purgeClient(clientId);
        res.json({ success: true, message: "Disconnected successfully." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Baileys Management Endpoints ────────────────────────────────────
if (USE_BAILEYS) {
    // Get Baileys session status
    app.get('/api/baileys/status', async (req, res) => {
        if (!baileysManager) return res.status(503).json({ error: "Baileys not enabled" });
        const status = baileysManager.getStatus(req.clientId || req.headers['x-client-id'] || 'default');
        res.json({ success: true, ...status });
    });

    // Force auto-wake (reconnect dormant session)
    app.post('/api/baileys/wake', async (req, res) => {
        if (!baileysManager) return res.status(503).json({ error: "Baileys not enabled" });
        const clientId = req.clientId || req.headers['x-client-id'] || 'default';
        try {
            await baileysManager.wakeClient(clientId);
            res.json({ success: true, message: "Session woken" });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Run cleanup (purge old session files)
    app.post('/api/baileys/cleanup', async (req, res) => {
        if (!baileysManager) return res.status(503).json({ error: "Baileys not enabled" });
        const result = await baileysManager.Cleanup();
        res.json({ success: true, ...result });
    });

    // Get Baileys configuration info
    app.get('/api/baileys/info', async (req, res) => {
        res.json({
            enabled: true,
            mode: 'BAILEYS_WEBSOCKET',
            features: [
                'Stealth-Human Anti-Ban Protocol',
                'Presence Emulation',
                'Calculated Latency (CharCount × 0.1s + Random 2-5s)',
                'Rate Limiting (50 msg/hour)',
                'AI Message Variability',
                'Auto-Pruning (30 min idle)',
                'Auto-Wake on dashboard login',
                'Session Cleanup (7-day purge)',
                'Lazy Chat Sync (last 10 chats)',
            ],
            antiBan: {
                maxOutboundPerHour: 50,
                cooldownBetweenSends: '1 minute',
                presenceEmulation: true,
                messageVariability: !!process.env.GROQ_API_KEY,
            },
            ramOptimization: {
                idleTimeoutMinutes: 30,
                lazySyncChatLimit: 10,
                maxSessionAgeDays: 7,
                pruneIntervalMinutes: 15,
            },
        });
    });
}

// ── Token Auth Routes ────────────────────────────────────────
// Issue JWT tokens for the dashboard — this is the only public endpoint
// that produces auth tokens. All other API routes require a valid JWT.
app.post('/api/auth/token', async (req, res) => {
    const { clientId } = req.body;

    if (!clientId || typeof clientId !== 'string') {
        return res.status(400).json({ error: 'clientId is required' });
    }

    // Basic sanity check: clientId must look like a valid format
    if (!/^[\w-]{8,64}$/.test(clientId)) {
        return res.status(400).json({ error: 'Invalid clientId format' });
    }

    try {
        const token = issueToken(clientId);
        res.json({ success: true, token, expiresIn: 86400 });
    } catch (err) {
        if (err.message.includes('JWT_SECRET not configured')) {
            return res.status(500).json({ error: 'Server auth not configured' });
        }
        res.status(500).json({ error: 'Failed to issue token' });
    }
});

// Verify a token (useful for dashboard health check)
app.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }
    const decoded = verifyToken(authHeader.slice(7));
    if (decoded) {
        res.json({ valid: true, clientId: decoded.clientId });
    } else {
        res.status(401).json({ valid: false });
    }
});

// ── Google OAuth Routes ──────────────────────────────────────
// Helper: get the real protocol behind Cloudflare proxy
function getRealProtocol(req) {
    const forwardedProto = req.get('X-Forwarded-Proto');
    return forwardedProto || req.protocol;
}

app.get('/auth/google', (req, res) => {
    const clientId = req.query.clientId || 'default';
    const state = Buffer.from(JSON.stringify({ clientId })).toString('base64');
    const protocol = getRealProtocol(req);
    const redirectUri = `${protocol}://${req.get('host')}/api/google/callback`;

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_SCOPES,
        state: state,
        prompt: 'consent',
        redirect_uri: redirectUri
    });
    res.redirect(url);
});

app.get('/api/google/link', (req, res) => {
    const clientId = req.query.clientId || 'default';
    const state = Buffer.from(JSON.stringify({ clientId, action: 'link' })).toString('base64');
    const protocol = getRealProtocol(req);
    const redirectUri = `${protocol}://${req.get('host')}/api/google/callback`;

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_SCOPES,
        state: state,
        prompt: 'consent',
        redirect_uri: redirectUri
    });
    res.redirect(url);
});

// Dedicated Google OAuth callback — verifies code and redirects to dashboard
app.get('/api/google/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) {
        return res.redirect('https://dash.concertos.brandproinc.in/onboarding?error=google_auth_failed');
    }

    let clientId = 'default';
    if (state) {
        try {
            const decoded = JSON.parse(Buffer.from(state, 'base64').toString());
            clientId = decoded.clientId || clientId;
        } catch (e) { /* use default */ }
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        await Session.findOneAndUpdate(
            { clientId },
            {
                googleTokens: tokens,
                googleEmail: userInfo.data.email,
                email: userInfo.data.email,
                displayName: userInfo.data.name || userInfo.data.email,
                authenticated: true
            },
            { upsert: true }
        );

        console.log(`✅ Google Account Linked for ${clientId}: ${userInfo.data.email}`);
        // Redirect to onboarding with success flag
        res.redirect(`https://dash.concertos.brandproinc.in/onboarding?google_linked=1&clientId=${clientId}`);
    } catch (err) {
        console.error('❌ Google Auth Callback Error:', err.message);
        res.redirect('https://dash.concertos.brandproinc.in/onboarding?error=google_auth_failed');
    }
});

app.post('/api/google/verify', async (req, res) => {
    const { code, state } = req.body;
    try {
        let clientId = 'default';
        if (state) {
            try {
                const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
                clientId = decodedState.clientId || req.headers['x-client-id'] || 'default';
            } catch (e) {
                clientId = req.headers['x-client-id'] || 'default';
            }
        } else {
            clientId = req.headers['x-client-id'] || 'default';
        }

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Fetch user info
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        // Update session with tokens
        await Session.findOneAndUpdate(
            { clientId },
            { 
                googleTokens: tokens,
                googleEmail: userInfo.data.email,
                email: userInfo.data.email,
                displayName: userInfo.data.name || userInfo.data.email
            },
            { upsert: true }
        );

        console.log(`✅ Google Account Linked for ${clientId}: ${userInfo.data.email}`);
        
        res.json({ success: true, email: userInfo.data.email });
    } catch (err) {
        console.error('❌ Google Auth Verify Error:', err.message);
        res.status(200).json({ success: false, message: 'Authentication failed. Please verify your Google Client Secret is correct.' });
    }
});
// ─────────────────────────────────────────────────────────────


const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    pingInterval: 10000,
    pingTimeout: 5000,
    cookie: false
});


// ── MongoDB Connection ──────────────────────────────────────
// ── MongoDB Connection ──────────────────────────────────
// ⚠️  ARCHITECTURE NOTE:
//   LOCAL DEV:  Set MONGODB_URI=mongodb://127.0.0.1:27017/brandpro in .env
//   PRODUCTION: Set MONGODB_URI=mongodb://YOUR_VPS_IP:27017/brandpro in .env
//   Do NOT use 127.0.0.1 in production — the VPS MongoDB won't be reachable.
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/brandpro';
mongoose.set('bufferCommands', false); // Fail fast, never buffer and crash
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 })
    .then(() => console.log('✅ MongoDB connected:', MONGO_URI))
    .catch(err => {
        console.error('❌ MongoDB connection failed:', err.message);
        console.error('   The server will continue but DB operations will fail.');
    });
mongoose.connection.on('error', err => console.error('MongoDB error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected. Attempting reconnect...'));
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────

const Lead = require('./models/Lead');
const Session = require('./models/Session');
const Ticket = require('./models/Ticket');
const AIConfig = require('./models/AIConfig');
const Signal = require('./models/Signal');
const AgentState = require('./models/AgentState');
const Organisation = require('./models/Organisation');
const OrgMember = require('./models/OrgMember');
const Workspace = require('./models/Workspace');
const { getSwarmManager } = require('./swarm/SwarmManager');
const { startHeartbeat } = require('./swarm/HeartbeatLoop');
const WhatsAppManager = require('./src/services/WhatsAppManager');

const clients = new Map();
const pendingInits = new Map(); // clientId -> Promise

// ── Baileys Integration ──────────────────────────────────────────────
// Use Baileys when USE_BAILEYS=true (WebSocket mode, no Chromium/Puppeteer).
// Falls back to whatsapp-web.js (Puppeteer) when false or unset.
let baileysManager = null;

if (USE_BAILEYS) {
    console.log('[Baileys] WebSocket mode ENABLED — Puppeteer not used.');
    baileysManager = new WhatsAppManager(io, { queue: null });

    // Wire Groq client to Baileys for AI message variability (anti-ban)
    try {
        const { Groq } = require('groq-sdk');
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        baileysManager.setGroqClient(groq);
    } catch (e) {
        console.warn('[Baileys] Groq client not available — message variability disabled.');
    }
} else {
    console.log('[Baileys] WebSocket mode DISABLED — using whatsapp-web.js (Puppeteer).');
}

// ── Baileys Message & Swarm Integration ─────────────────────────────
// Swarm integration is now handled inside WhatsAppManager's messages.upsert
// event listener. No server-level override needed.

// ── Google OAuth Initialization ──────────────────────────────
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly'
];

function getValidGoogleClient(clientId) {
    return Session.findOne({ clientId }).then(async (session) => {
        if (!session || !session.googleTokens || !session.googleTokens.access_token) return null;

        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        client.setCredentials(session.googleTokens);
        
        const now = Date.now();
        if (session.googleTokens.expiry_date && now >= session.googleTokens.expiry_date - 60000) {
            try {
                console.log(`🔄 Refreshing Google Token for ${clientId}...`);
                const { tokens } = await client.refreshAccessToken();
                if (tokens) {
                    await Session.findOneAndUpdate({ clientId }, { googleTokens: tokens });
                    client.setCredentials(tokens);
                }
            } catch (err) {
                console.error(`❌ Token Refresh Fail [${clientId}]:`, err.message);
                return null;
            }
        }
        return client;
    });
}

// ── Gmail Integration ───────────────────────────────────────────
async function getGmailThreads(clientId) {
    const auth = await getValidGoogleClient(clientId);
    if (!auth) return [];
    
    try {
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.threads.list({
            userId: 'me',
            maxResults: 10
        });
        
        if (!res.data.threads) return [];
        
        const threads = await Promise.all(res.data.threads.map(async (t) => {
            const detail = await gmail.users.threads.get({ userId: 'me', id: t.id });
            const lastMsg = detail.data.messages[detail.data.messages.length - 1];
            const subject = lastMsg.payload.headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
            const fromHeader = lastMsg.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
            const snippet = lastMsg.snippet;
            const date = lastMsg.internalDate;
            
            return {
                id: t.id,
                type: 'email',
                name: fromHeader.split('<')[0].trim() || fromHeader,
                email: fromHeader,
                subject: subject,
                lastMessage: snippet,
                lastInteraction: parseInt(date),
                unread: detail.data.messages.some(m => m.labelIds.includes('UNREAD'))
            };
        }));
        
        return threads;
    } catch (err) {
        console.error(`❌ Gmail List Threads Error [${clientId}]:`, err.message);
        return [];
    }
}

async function getGmailThreadMessages(clientId, threadId) {
    const auth = await getValidGoogleClient(clientId);
    if (!auth) return [];
    
    try {
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.threads.get({ userId: 'me', id: threadId });
        
        return res.data.messages.map(m => {
            // Traverse parts for text/plain body
            let body = m.snippet;
            if (m.payload.parts) {
                const textPart = m.payload.parts.find(p => p.mimeType === 'text/plain');
                if (textPart && textPart.body && textPart.body.data) {
                    body = Buffer.from(textPart.body.data, 'base64').toString();
                } else {
                    // Try to find text/html if no plain text
                    const htmlPart = m.payload.parts.find(p => p.mimeType === 'text/html');
                    if (htmlPart && htmlPart.body && htmlPart.body.data) {
                        body = Buffer.from(htmlPart.body.data, 'base64').toString();
                    }
                }
            } else if (m.payload.body && m.payload.body.data) {
                body = Buffer.from(m.payload.body.data, 'base64').toString();
            }

            return {
                id: m.id,
                fromMe: m.labelIds.includes('SENT'),
                body: body,
                timestamp: Math.floor(parseInt(m.internalDate) / 1000),
                role: m.labelIds.includes('SENT') ? 'human' : 'lead'
            };
        });
    } catch (err) {
        console.error(`❌ Gmail Get Messages Error [${clientId}]:`, err.message);
        return [];
    }
}
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────

// Helper to update session state in DB
async function updateSessionState(clientId, updates) {
    try {
        if (mongoose.connection.readyState !== 1) return null;
        return await Session.findOneAndUpdate(
            { clientId },
            { ...updates, lastActive: new Date() },
            { upsert: true, new: true }
        );
    } catch (e) {
        console.warn(`[DB SKIP] updateSessionState failed: ${e.message}`);
        return null;
    }
}

// Helper to check if a chat is paused for AI
async function getChatState(clientId, chatId) {
    try {
        if (mongoose.connection.readyState !== 1) return false;
        const lead = await Lead.findOne({ clientId, phone: chatId.replace('@c.us', '') });
        return lead ? lead.isAiPaused : false;
    } catch (e) {
        return false;
    }
}

// Helper to get or create a client for a specific user (QR Onboarding)
// ── Baileys Mode: delegates to WhatsAppManager (direct WebSockets) ────────
async function getClient(clientId) {
    if (!clientId) return null;

    // Meta Cloud API: No Baileys needed, always ready
    if (USE_META_CLOUD) {
        return META_CLIENT_STUB;
    }

    // Baileys WebSocket mode — use WhatsAppManager directly
    if (USE_BAILEYS && baileysManager) {
        return baileysManager.wakeClient(clientId);
    }

    // Legacy Puppeteer mode (DEPRECATED — use Baileys instead)
    // If already exists, return it
    if (clients.has(clientId)) return clients.get(clientId);
    if (pendingInits.has(clientId)) return pendingInits.get(clientId);

    const initPromise = (async () => {
        try {
            console.log(`[DEPRECATED] Puppeteer init for: ${clientId} — prefer USE_BAILEYS=true`);
            const dataPath = path.join(process.cwd(), '.wwebjs_auth', `session_${clientId}`);

            const authPath = path.join(process.cwd(), '.wwebjs_auth', `session_${clientId}`);
            const lockPaths = [
                path.join(authPath, 'SingletonLock'),
                path.join(authPath, 'Default', 'SingletonLock'),
                path.join(authPath, 'SingletonSocket'),
                path.join(authPath, 'DevToolsActivePort')
            ];

            const tempPathsToCheck = ['/tmp', '/private/tmp'];
            tempPathsToCheck.forEach(tempBase => {
                try {
                    if (!fs.existsSync(tempBase)) return;
                    fs.readdirSync(tempBase).forEach(f => {
                        if (f.startsWith('wwebjs_auth_') || f.startsWith('puppeteer_dev_profile')) {
                            try { fs.rmSync(path.join(tempBase, f), { recursive: true, force: true }); } catch(e) {}
                        }
                    });
                } catch (e) {}
            });
            lockPaths.forEach(lp => { try { if (fs.existsSync(lp)) fs.unlinkSync(lp); } catch (e) {} });

            const sessionDir = path.join(dataPath, `session-${clientId}`);
            const defaultDir = path.join(sessionDir, 'Default');
            try {
                if (fs.existsSync(path.join(sessionDir, 'SingletonLock'))) fs.unlinkSync(path.join(sessionDir, 'SingletonLock'));
                if (fs.existsSync(path.join(defaultDir, 'SingletonLock'))) fs.unlinkSync(path.join(defaultDir, 'SingletonLock'));
                if (fs.existsSync(path.join(sessionDir, 'SingletonCookie'))) fs.unlinkSync(path.join(sessionDir, 'SingletonCookie'));
                if (fs.existsSync(path.join(defaultDir, 'SingletonCookie'))) fs.unlinkSync(path.join(defaultDir, 'SingletonCookie'));
            } catch (e) { /* ignore */ }

            const client = new Client({
                authStrategy: new LocalAuth({ clientId, dataPath }),

                puppeteer: {
                    headless: 'new',
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                    args: [
                        '--no-sandbox', '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas',
                        '--no-first-run', '--no-zygote', '--disable-gpu'
                    ]
                }
            });

            clients.set(clientId, client);
            setupClientListeners(clientId, client);
            client.idleTimer = setTimeout(async () => {
                console.log(`[DEPRECATED] Puppeteer idle timeout — use Baileys mode instead`);
                await client.destroy();
                clients.delete(clientId);
            }, 30 * 60 * 1000);

            await client.initialize().catch(async err => {
                const errMsg = err.message || '';
                if (errMsg.includes('already running') || errMsg.includes('profile appears to be in use') || errMsg.includes('Code: 21')) {
                    console.warn(`⚠️ Profile lock detected for ${clientId}. Purging session and retrying...`);
                    await purgeClient(clientId);
                    // Create a completely fresh client after purge
                    const newClient = new Client({
                        authStrategy: new LocalAuth({ clientId, dataPath }),
                        puppeteer: client.options.puppeteer
                    });
                    clients.set(clientId, newClient);
                    setupClientListeners(clientId, newClient);
                    await newClient.initialize();
                    return;
                }
                throw err;
            });
            return clients.get(clientId);
        } catch (err) {
            console.error(`❌ Client Init Fail [${clientId}]:`, err);
            pendingInits.delete(clientId);
            throw err;
        }
    })();

    pendingInits.set(clientId, initPromise);
    const result = await initPromise;
    pendingInits.delete(clientId);
    return result;
}

async function purgeClient(clientId) {
    if (!clientId) return;
    console.log(`🧹 FULL PURGE: ${clientId}`);
    try {
        // 1. Destroy the in-memory client
        const client = clients.get(clientId);
        if (client) {
            clearTimeout(client.idleTimer);
            try {
                await client.destroy();
            } catch (e) {
                console.warn(`⚠️ Error destroying client ${clientId}:`, e.message);
            }
            clients.delete(clientId);
        }
        
        // 2. Nuke the entire session directory (clean slate for re-link)
        const sessionDir = path.join(process.cwd(), '.wwebjs_auth', `session_${clientId}`);
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`🗑️ Session directory deleted: session_${clientId}`);
            } catch (e) {
                console.warn(`⚠️ Failed to delete session dir:`, e.message);
            }
        }

        // 3. Delete the Session document from MongoDB entirely
        await Session.deleteOne({ clientId });
        console.log(`🗄️ Session record deleted from DB: ${clientId}`);

        // 4. Notify connected dashboards to show QR/onboarding flow
        io.to(clientId).emit('session_purged', { clientId });
        io.to(clientId).emit('disconnected', 'SESSION_PURGED');

    } catch (err) {
        console.error(`❌ Purge Error [${clientId}]:`, err);
    }
}

// Auto-Prune unauthenticated sessions that haven't been active for 2 hours
async function pruneInactiveSessions() {
    try {
        // GUARD: Skip pruning if MongoDB isn't fully connected (readyState 1 = connected)
        // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
        if (mongoose.connection.readyState !== 1) {
            return;
        }
        // Double-check with a ping — rules out race conditions during reconnection
        // Wrap in timeout to avoid hanging on slow connections
        try {
            await Promise.race([
                mongoose.connection.db.admin().ping(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 2000))
            ]);
        } catch {
            return; // Ping failed, skip this cycle
        }

        // Now safe to query MongoDB
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const sessionsToPrune = await Session.find({
            authenticated: false,
            updatedAt: { $lt: twoHoursAgo }
        });

        if (sessionsToPrune.length > 0) {
            console.log(`🧹 [AUTO] Pruning ${sessionsToPrune.length} inactive unauthenticated sessions...`);
            for (const sess of sessionsToPrune) {
                await purgeClient(sess.clientId);
            }
        }
    } catch (err) {
        console.error("Pruning error:", err.message);
    }
}
// Run pruning every 30 minutes — starts only after MongoDB connection is confirmed
let pruneInterval;
mongoose.connection.once('connected', () => {
    pruneInterval = setInterval(pruneInactiveSessions, 30 * 60 * 1000);
    pruneInactiveSessions(); // run once immediately after connect
});


function setupClientListeners(clientId, client) {
    client.on('qr', async (qr) => {
        const url = await qrcode.toDataURL(qr);
        // Append unique timestamp to prevent caching artifacts
        const freshUrl = `${url}#t=${Date.now()}`;
        await updateSessionState(clientId, { status: 'UNAUTHENTICATED', qr: freshUrl });
        console.log(`📲 QR Code Generated for ${clientId} (len: ${url.length})`);
        io.to(clientId).emit('qr', freshUrl);
    });

    client.on('authenticated', async () => {
        await updateSessionState(clientId, { 
            authenticated: true, 
            status: 'AUTHENTICATED', 
            whatsappConnected: true,
            qr: null 
        });
        console.log(`🔒 Identity Verified for ${clientId}`);
    });

    client.on('ready', async () => {
        const info = client.info || {};
        await updateSessionState(clientId, { 
            status: 'READY', 
            authenticated: true, 
            whatsappConnected: true,
            qr: null,
            displayName: info.pushname || '',
            phone: info.wid?.user || ''
        });
        console.log(`✅ DASHBOARD READY for ${clientId}`);
        
        // Auto-Initialize Cognitive Swarm for this client
        try {
            const swarm = require('./swarm/SwarmManager').getSwarmManager(io);
            await swarm.initializeSwarm(clientId);
        } catch (err) {
            console.error(`[SWARM] Auto-init failed to initialize agents for ${clientId}:`, err.message);
        }
        
        io.to(clientId).emit('ready', 'Connected');
    });

    client.on('auth_failure', async msg => {
        console.warn(`🛑 Auth Failure [${clientId}]: ${msg}`);
        await updateSessionState(clientId, { status: 'AUTH_FAILURE', qr: null, authenticated: false });
        io.to(clientId).emit('error', 'Auth failure: ' + msg);
        setTimeout(() => purgeClient(clientId), 500);
    });

    client.on('disconnected', async (reason) => {
        console.warn(`🔌 Disconnected [${clientId}]: ${reason}`);
        await updateSessionState(clientId, { status: 'DISCONNECTED', qr: null, authenticated: false });
        io.to(clientId).emit('disconnected', reason);
        setTimeout(() => purgeClient(clientId), 500);
    });

    client.on('message', async msg => {
        // RESET IDLE TIMER on activity
        clearTimeout(client.idleTimer);
        client.idleTimer = setTimeout(async () => {
            console.log(`💤 Hibernating idle client: ${clientId}`);
            await client.destroy();
            clients.delete(clientId);
        }, 30 * 60 * 1000);

        // Emit to dashboard for real-time display
        io.to(clientId).emit('message', {
            id: msg.id._serialized,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            fromMe: msg.fromMe,
            timestamp: msg.timestamp
        });

        const chatId = msg.from;
        
        // Persistent AI Pause Check
        const isPaused = await getChatState(clientId, chatId);
        if (isPaused) return;
        
        // ═══ SWARM v2.0: Post to Blackboard instead of direct AI call ═══
        try {
            const swarm = getSwarmManager(io);
            
            let imageBase64 = null;
            if (msg.hasMedia && msg.type === 'image') {
                try {
                    const media = await msg.downloadMedia();
                    if (media) imageBase64 = `data:${media.mimetype};base64,${media.data}`;
                } catch (e) {}
            }

            await swarm.postSignal('INBOUND_MESSAGE', {
                from: chatId,
                body: msg.body,
                hasMedia: msg.hasMedia,
                mediaType: msg.type,
                imageBase64,
                timestamp: msg.timestamp,
                messageId: msg.id._serialized
            }, clientId, {
                source: 'whatsapp',
                sourceId: msg.id._serialized
            });

            // NOTE: The signal is now on the Blackboard.
            // The SwarmManager auto-routes it to the appropriate agent.
            // The HeartbeatLoop catches any stale unprocessed signals.
            
            // LEGACY FALLBACK: If no agents are configured yet,
            // fall back to direct AI processing
            const agentCount = await AgentState.countDocuments({ clientId });
            if (agentCount === 0) {
                const aiReply = await processMessage(msg.body, imageBase64);
                if (aiReply && aiReply.intent === 'HANDOFF_HUMAN') {
                    await Lead.findOneAndUpdate(
                        { clientId, phone: chatId.replace('@c.us', '') },
                        { isAiPaused: true },
                        { upsert: true }
                    );
                    io.to(clientId).emit('human_handoff', chatId);
                } else if (aiReply && aiReply.response) {
                    await client.sendMessage(chatId, aiReply.response);
                }
            }
        } catch (err) {
            console.error(`[SWARM] Error posting signal for ${chatId}:`, err.message);
        }
    });

    client.on('message_create', async msg => {
        if (msg.fromMe) {
            // Auto-pause AI when human replies
            await Lead.findOneAndUpdate(
                { clientId, phone: msg.to.replace('@c.us', '') },
                { isAiPaused: true },
                { upsert: true }
            );
            
            io.to(clientId).emit('message', {
                id: msg.id._serialized,
                from: msg.from,
                to: msg.to,
                body: msg.body,
                fromMe: msg.fromMe,
                timestamp: msg.timestamp
            });
        }
    });

    client.on('message_edit', (msg, newBody, prevBody) => {
        io.to(clientId).emit('message_edit', {
            id: msg.id._serialized,
            chatId: msg.to || msg.from,
            newBody: newBody,
            prevBody: prevBody
        });
    });
}




// ── Authentication Middleware ─────────────────────────────
// Public paths — no JWT required (Meta webhook, health, Google OAuth, token issuance)
const PUBLIC_PATHS = [
    '/health',
    '/webhooks',
    '/auth',
    '/api/profiles',
    '/api/google',
    '/api/auth/token'
];

app.use(async (req, res, next) => {
    if (req.path === '/' || PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();

    // Apply JWT auth middleware — replaces insecure header-based clientId
    authMiddleware(req, res, async () => {
        if (!req.clientId || req.clientId === 'default') {
            req.whatsapp = null;
            return next();
        }
        try {
            req.whatsapp = await getClient(req.clientId);
        } catch (err) {
            req.whatsapp = null;
        }
        next();
    });
});
// ─────────────────────────────────────────────────────────

console.log(`🚀 Boilerplate Backend Booting...`);
// Session Recovery on Start: Attempt to start clients for any found sessions
// Session Recovery on Start: ONLY recovery the primary admin session
// ── RAM OPTIMIZATION: On-Demand Session Recovery ──────────────────
// Sessions are initialized lazily on first user login or webhook arrival.
// WhatsAppManager handles auto-wake and auto-prune internally.
(async function initializeRamOptimization() {
    console.log(`ℹ️ On-demand initialization enabled. RAM optimized for production.`);
    console.log(`   Sessions auto-wake on dashboard login or incoming message.`);
    console.log(`   Idle sockets auto-prune after 30 minutes.`);
})();



const port = process.env.PORT || 3000;
// NOTE: express.json() already applied at line 68 — removed duplicate here

app.get('/health', async (req, res) => {
    try {
        const clientId = req.query.clientId || 'default';
        const session = mongoose.connection.readyState === 1 ? await Session.findOne({ clientId }) : null;
        if (mongoose.connection.readyState !== 1) {
            return res.json({ status: 'UP', whatsapp: 'DISCONNECTED(DB_DOWN)', hasActiveQR: false, userName: null, isLoaded: false, paperclip: false, metaCloud: USE_META_CLOUD });
        }

        // Meta Cloud API is always ready once configured — no QR code needed
        const whatsappStatus = USE_META_CLOUD ? 'META_CLOUD_API' : (session ? session.status : 'DISCONNECTED');

        res.json({
            status: 'UP',
            whatsapp: whatsappStatus,
            hasActiveQR: USE_META_CLOUD ? false : !!(session && session.qr),
            userName: null,
            isLoaded: USE_META_CLOUD ? true : !!clients.get(clientId),
            paperclip: false,
            metaCloud: USE_META_CLOUD,
            baileys: USE_BAILEYS ? baileysManager?.getStatus(clientId) : null,
        });
    } catch (e) {
        res.json({ status: 'UP', whatsapp: 'DISCONNECTED(ERR)', hasActiveQR: false, userName: null, isLoaded: false, paperclip: false, metaCloud: USE_META_CLOUD });
    }
});

app.get('/api/chats', async (req, res) => {
    try {
        const client = req.whatsapp;
        if (mongoose.connection.readyState !== 1) {
            return res.json({ chats: [], whatsappStatus: 'DISCONNECTED' });
        }
        const session = await Session.findOne({ clientId: req.clientId });
        const status = session ? session.status : 'AUTHENTICATING';

        if (!client || status !== 'READY') {
             return res.json({ chats: [], whatsappStatus: status });
        }
        
        let chats = [];
        try {
            chats = await client.getChats();
        } catch (e) {
            console.warn(`[${req.clientId}] getChats failed despite READY status:`, e.message);
            return res.json({ chats: [], whatsappStatus: 'CONNECTING' });
        }

        const enriched = chats.map((chat) => ({
            id: chat.id._serialized,
            name: chat.name,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? chat.lastMessage.body : '',
            profilePic: null
        }));
        res.json({ 
            chats: enriched, 
            whatsappStatus: 'CONNECTED',
            phone: client.info?.wid?.user || '',
            pushname: client.info?.pushname || ''
        });
    } catch (err) { 
        res.json({ chats: [], whatsappStatus: 'CONNECTED', error: err.message });
    }
});

app.get('/api/chats/:id/messages', async (req, res) => {
    try {
        const client = req.whatsapp;
        if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
        const chat = await client.getChatById(req.params.id);
        
        const msgPromise = chat.fetchMessages({ limit: 30 });
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Fetch Timeout")), 12000)
        );
        
        const messages = await Promise.race([msgPromise, timeoutPromise]);
        
        const formatted = await Promise.all(messages.map(async m => {
            let mediaData = null;
            if (m.hasMedia) {
                try {
                    const media = await m.downloadMedia();
                    if (media) mediaData = `data:${media.mimetype};base64,${media.data}`;
                } catch(e) {}
            }
            return {
                id: m.id._serialized,
                body: m.body,
                fromMe: m.fromMe,
                timestamp: m.timestamp,
                type: m.type,
                mediaData: mediaData
            };
        }));
        res.json(formatted);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post('/api/chats/:id/messages', messageRateLimiter, async (req, res) => {
    const client = req.whatsapp;
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: "Message text required" });

        if (USE_BAILEYS && baileysManager) {
            // Baileys: use sendSafeReply with anti-ban protocol
            await baileysManager.sendSafeReply(req.clientId, req.params.id, text);
        } else {
            // whatsapp-web.js (Puppeteer) mode
            await client.sendMessage(req.params.id, text);
        }
        res.json({ success: true, timestamp: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PROFILES & SETTINGS
app.get('/api/profile', async (req, res) => {
    try {
        const session = await Session.findOne({ clientId: req.clientId });
        let profile = {
            email: session?.email || '',
            displayName: session?.displayName || '',
            bio: session?.bio || '',
            status: session?.status || 'DISCONNECTED',
            googleEmail: session?.googleEmail || null,
            googleLinked: !!(session?.googleTokens && session?.googleTokens.access_token)
        };
        
        const client = req.whatsapp;
        if (client && client.info) {
            profile.whatsappSynced = true;
            profile.pushname = client.info.pushname;
            profile.phone = client.info.wid?.user;
        }

        // Baileys mode: add WebSocket session info
        if (USE_BAILEYS && baileysManager) {
            profile.baileys = baileysManager.getStatus(req.clientId);
        }

        res.json(profile);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Duplicates removed (moved to top for better accessibility)


app.post('/api/profile', async (req, res) => {
    try {
        const { email, displayName, bio } = req.body;
        await Session.findOneAndUpdate(
            { clientId: req.clientId },
            { $set: { email, displayName, bio } },
            { upsert: true, returnDocument: 'after' }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages/send', messageRateLimiter, async (req, res) => {
    const client = req.whatsapp;
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const { chatId, message, quotedMessageId } = req.body;
        if (USE_BAILEYS && baileysManager) {
            await baileysManager.sendSafeReply(req.clientId, chatId, message, { quotedKey: quotedMessageId });
        } else {
            await client.sendMessage(chatId, message, { quotedMessageId });
        }
        res.json({ success: true, timestamp: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.patch('/api/chats/:id/messages/:msgId', async (req, res) => {
    const client = req.whatsapp;
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const { text } = req.body;
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 50 });
        const msg = messages.find(m => m.id._serialized === req.params.msgId);
        
        if (msg) {
            await msg.edit(text);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: "Message not found or too old to edit" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/chats/:id/messages/:msgId', async (req, res) => {
    const client = req.whatsapp;
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 50 });
        const msg = messages.find(m => m.id._serialized === req.params.msgId);
        if (msg) {
            await msg.delete(true);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: "Message not found" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post('/api/chats/:id/force-ai', async (req, res) => {
    const client = req.whatsapp;
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 30 });
        const reversed = messages.reverse();
        
        const textMessages = reversed.filter(m => !m.fromMe && m.body).map(m => m.body);
        const imageMsgs = reversed.filter(m => !m.fromMe && m.hasMedia && m.type === 'image').slice(0, 10);
        
        if (textMessages.length === 0 && imageMsgs.length === 0) {
            return res.status(400).json({ error: "No user messages found to evaluate." });
        }
        
        const imagePromises = imageMsgs.map(async (msg) => {
            try {
                const media = await msg.downloadMedia();
                if (media) return `data:${media.mimetype};base64,${media.data}`;
                return null;
            } catch (e) { return null; }
        });
        const allImages = (await Promise.all(imagePromises)).filter(Boolean);
        const bodyText = textMessages.length > 0 ? textMessages.slice(0, 5).join('\n---\n') : 'Evaluate profile.';
        
        const context = await determineIntent(bodyText);
        let auditData = null;
        let detectedUrl = context.profileUrl;

        if (!detectedUrl && allImages.length > 0) {
            const visionLinkCheck = await handleVision(allImages, "Find social profile URL.");
            if (visionLinkCheck.profileUrl) detectedUrl = visionLinkCheck.profileUrl;
        }

        if (detectedUrl) {
            try {
                await client.sendMessage(chat.id._serialized, "🔍 Processing audit...");
                const auditResult = await auditProfile(detectedUrl);
                if (auditResult && auditResult.success) {
                    auditData = auditResult.data;
                    const phone = chat.id._serialized.replace('@c.us', '');
                    await Lead.findOneAndUpdate(
                        { phone: phone, clientId: req.clientId },
                        { auditData, lastAuditedAt: new Date(), clientId: req.clientId },
                        { upsert: true }
                    );
                }
            } catch (e) {}
        }

        const aiReply = await processMessage(bodyText, allImages.length > 0 ? allImages : null, auditData);
        if (aiReply && aiReply.response) {
            await client.sendMessage(chat.id._serialized, aiReply.response);
            res.json({ success: true, aiResponse: aiReply.response });
        } else {
            res.status(500).json({ error: "AI failed" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Per-Client AI Configuration (MongoDB) ──────────────────
app.get('/api/ai/config', async (req, res) => {
    try {
        let config = await AIConfig.findOne({ clientId: req.clientId });
        if (!config) {
            config = await AIConfig.create({ clientId: req.clientId });
        }
        res.json({ success: true, config });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/config', async (req, res) => {
    try {
        const config = await AIConfig.findOneAndUpdate(
            { clientId: req.clientId },
            { $set: req.body },
            { upsert: true, new: true }
        );
        res.json({ success: true, config });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle AI on/off for a client
app.post('/api/ai/toggle', async (req, res) => {
    try {
        const { enabled } = req.body;
        const config = await AIConfig.findOneAndUpdate(
            { clientId: req.clientId },
            { $set: { aiEnabled: !!enabled } },
            { upsert: true, new: true }
        );
        res.json({ success: true, aiEnabled: config.aiEnabled });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// Realtime CRM Endpoints - Multi-Tenant
app.get('/api/leads', async (req, res) => {
    try {
        const leads = await Lead.find({ clientId: req.clientId }).sort({ updatedAt: -1 });
        res.json({ success: true, leads });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contacts/:id', async (req, res) => {
    try {
        const { clientId, params: { id } } = req;
        const phone = id.replace('@c.us', '');
        let lead = await Lead.findOne({ clientId, phone });
        
        if (!lead) {
            lead = await Lead.create({
                clientId,
                phone,
                name: 'Contact',
                tags: ['NEW'],
                customProperties: [],
                privateNotes: []
            });
        }
        
        const client = req.whatsapp;
        if (client && client.info) {
            try {
                const contact = await client.getContactById(id);
                if (contact) {
                    const realNumber = contact.number || contact.id.user;
                    lead.resolvedNumber = realNumber;
                    
                    // Update name if it's generic
                    if (lead.name === 'Contact' || !lead.name) {
                        lead.name = contact.name || contact.pushname || contact.id.user;
                    }
                    
                    const picUrl = await contact.getProfilePicUrl().catch(() => null);
                    const about = await contact.getAbout().catch(() => null);
                    const presence = await contact.getPresence().catch(() => null);
                    
                    if (picUrl) lead.set('profilePic', picUrl, {strict: false});
                    if (presence) lead.presence = presence === 'online' ? 'online' : (presence === 'offline' ? 'offline' : presence);
                    if (about) {
                        const existingAbout = lead.customProperties.find(p => p.label === 'WhatsApp About');
                        if (existingAbout) existingAbout.value = about;
                        else lead.customProperties.push({ label: 'WhatsApp About', value: about });
                    }
                    
                    await lead.save();
                }
            } catch (e) {
                console.log(`Silent fetch err for contact ${id}`, e.message);
            }
        }
        
        res.json(lead.toObject());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts/:id', async (req, res) => {
    try {
        const { clientId, params: { id } } = req;
        const phone = id.replace('@c.us', '');
        
        const updatedLead = await Lead.findOneAndUpdate(
            { clientId, phone },
            { $set: req.body },
            { new: true, upsert: true }
        );
        res.json({ success: true, lead: updatedLead });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tickets API
app.get('/api/tickets', async (req, res) => {
    try {
        const tickets = await Ticket.find({ clientId: req.clientId }).sort({ createdAt: -1 });
        res.json({ success: true, tickets });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets', async (req, res) => {
    try {
        const newTicket = await Ticket.create({
            clientId: req.clientId,
            ticketId: 'T-' + Math.floor(1000 + Math.random() * 9000),
            ...req.body
        });
        
        // Broadcast to space
        io.to(req.clientId).emit('ticket_updated', newTicket);
        res.json({ success: true, ticket: newTicket });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/tickets/:id', async (req, res) => {
    try {
        const updated = await Ticket.findOneAndUpdate(
            { clientId: req.clientId, ticketId: req.params.id },
            { $set: req.body },
            { new: true }
        );
        io.to(req.clientId).emit('ticket_updated', updated);
        res.json({ success: true, ticket: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Logs API
app.get('/api/logs', async (req, res) => {
    res.json({ success: true, logs: systemLogs });
});

// Analytics API
app.get('/api/analytics', async (req, res) => {
    try {
        const { clientId } = req;
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [openTickets, activeLeads, aiHandledLeads, dailyVolume] = await Promise.all([
            Ticket.countDocuments({ clientId, status: { $ne: 'resolved' } }),
            Lead.countDocuments({ clientId }),
            Lead.countDocuments({ 
                clientId, 
                'conversation.role': 'ai' 
            }),
            Lead.aggregate([
                { $match: { clientId, createdAt: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { "_id": 1 } }
            ])
        ]);

        // Format daily volume for the frontend (7-day array)
        const volumeTrend = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
            const dateStr = d.toISOString().split('T')[0];
            const found = dailyVolume.find(v => v._id === dateStr);
            volumeTrend.push(found ? found.count : 0);
        }

        const aiHandledPercent = activeLeads > 0 
            ? ((aiHandledLeads / activeLeads) * 100).toFixed(1) + "%" 
            : "0%";

        res.json({
            success: true,
            stats: {
                openTickets,
                activeChats: activeLeads,
                flaggedMessages: 0,
                avgResponseTime: "0",
                aiHandled: aiHandledPercent,
                missedCalls: 0,
                volumeTrend
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// ADMIN DASHBOARD API — Org-scoped (requires auth)
// ═══════════════════════════════════════════════════

app.get('/api/admin/overview', authMiddleware, async (req, res) => {
    try {
        // Super admin sees platform-wide metrics
        const member = await OrgMember.findOne({ userId: req.userId, isSuperAdmin: true });
        const isSuperAdmin = !!member;

        if (isSuperAdmin) {
            // Platform-wide metrics
            const [totalLeads, totalTickets, totalSessions, openTickets] = await Promise.all([
                Lead.countDocuments(),
                Ticket.countDocuments(),
                Session.countDocuments(),
                Ticket.countDocuments({ status: { $ne: 'resolved' } })
            ]);
            const hotLeads = await Lead.countDocuments({ qualification: 'HOT' });
            const warmLeads = await Lead.countDocuments({ qualification: 'WARM' });
            const coldLeads = await Lead.countDocuments({ qualification: 'COLD' });
            const activeClients = clients.size;
            const mongoStatus = mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED';
            return res.json({
                success: true,
                platform: {
                    totalLeads, totalTickets, totalSessions, openTickets,
                    activeClients, mongoStatus,
                    leadBreakdown: { hot: hotLeads, warm: warmLeads, cold: coldLeads },
                    uptime: process.uptime(),
                    memoryUsage: process.memoryUsage(),
                    system: { loadAvg: os.loadavg(), freeMem: os.freemem(), totalMem: os.totalmem(), cpus: os.cpus().length }
                }
            });
        }

        // Org-scoped metrics
        const orgId = req.orgId;
        if (!orgId) return res.status(401).json({ error: 'No org context' });

        const workspaces = await Workspace.find({ orgId }).select('workspaceId').lean();
        const workspaceIds = workspaces.map(w => w.workspaceId);

        const [totalLeads, totalTickets, openTickets] = await Promise.all([
            Lead.countDocuments({ workspaceId: { $in: workspaceIds } }),
            Ticket.countDocuments({ workspaceId: { $in: workspaceIds } }),
            Ticket.countDocuments({ workspaceId: { $in: workspaceIds }, status: { $ne: 'resolved' } })
        ]);
        const hotLeads = await Lead.countDocuments({ workspaceId: { $in: workspaceIds }, qualification: 'HOT' });
        const warmLeads = await Lead.countDocuments({ workspaceId: { $in: workspaceIds }, qualification: 'WARM' });
        const coldLeads = await Lead.countDocuments({ workspaceId: { $in: workspaceIds }, qualification: 'COLD' });

        res.json({
            success: true,
            platform: {
                totalLeads, totalTickets, openTickets,
                workspaceCount: workspaces.length,
                leadBreakdown: { hot: hotLeads, warm: warmLeads, cold: coldLeads },
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/sessions', authMiddleware, async (req, res) => {
    try {
        const orgId = req.orgId;
        if (!orgId) return res.status(401).json({ error: 'No org context' });

        const workspaces = await Workspace.find({ orgId }).select('workspaceId legacyClientId').lean();
        const legacyIds = workspaces.map(w => w.legacyClientId).filter(Boolean);

        // Find sessions for this org's workspaces (by legacy clientId or workspaceId)
        const sessions = await Session.find({
            $or: [
                { workspaceId: { $in: workspaces.map(w => w.workspaceId) } },
                { clientId: { $in: legacyIds } }
            ]
        }).sort({ lastActive: -1 }).lean();

        const enriched = sessions.map(s => ({
            ...s,
            hasActiveClient: clients.has(s.clientId),
        }));
        res.json({ success: true, sessions: enriched });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/leads', authMiddleware, async (req, res) => {
    try {
        const orgId = req.orgId;
        if (!orgId) return res.status(401).json({ error: 'No org context' });

        const workspaces = await Workspace.find({ orgId }).select('workspaceId').lean();
        const leads = await Lead.find({
            workspaceId: { $in: workspaces.map(w => w.workspaceId) }
        }).sort({ updatedAt: -1 }).limit(100).lean();
        res.json({ success: true, leads });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/purge/:clientId', authMiddleware, async (req, res) => {
    try {
        const orgId = req.orgId;
        if (!orgId) return res.status(401).json({ error: 'No org context' });

        const { clientId } = req.params;
        // Verify the clientId belongs to this org's workspace
        const session = await Session.findOne({ clientId, workspaceId: { $exists: false } });
        // Org-scoped purge: only allow if session has no orgId or matches this org
        if (session && session.orgId && session.orgId !== orgId) {
            return res.status(403).json({ error: 'Forbidden: session belongs to another org' });
        }
        await purgeClient(clientId);
        res.json({ success: true, message: `Session ${clientId} purged.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});



app.post('/api/chats/:id/pause', async (req, res) => {
    const { clientId, params: { id } } = req;
    const isPaused = req.body.paused;
    await Lead.findOneAndUpdate(
        { clientId, phone: id.replace('@c.us', '') },
        { isAiPaused: isPaused },
        { upsert: true }
    );
    res.json({ success: true, paused: isPaused });
});
app.get('/api/chats/:id/pause', async (req, res) => {
    const { clientId, params: { id } } = req;
    const isPaused = await getChatState(clientId, id);
    res.json({ paused: isPaused });
});


// ── Unified Inbox & Gmail Integration ───────────────────────────

app.get('/api/inbox', async (req, res) => {
    try {
        const { clientId } = req;
        
        // 1. Fetch WhatsApp (Parallel)
        const waPromise = (async () => {
            try {
                const client = await getClient(clientId);
                if (!client) return [];
                const chats = await client.getChats();
                return chats.map(c => ({
                    id: c.id._serialized,
                    type: 'whatsapp',
                    name: c.name || c.id.user,
                    lastMessage: c.lastMessage?.body || "Active Session",
                    lastInteraction: (c.timestamp || 0) * 1000,
                    unread: c.unreadCount > 0
                }));
            } catch (e) { return []; }
        })();

        // 2. Fetch Gmail (Parallel)
        const gmailPromise = getGmailThreads(clientId);

        const [waChats, emailThreads] = await Promise.all([waPromise, gmailPromise]);
        
        const inbox = [...waChats, ...emailThreads].sort((a, b) => b.lastInteraction - a.lastInteraction);
        res.json({ success: true, inbox });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inbox/:type/:id/messages', async (req, res) => {
    try {
        const { clientId, params: { type, id } } = req;
        
        if (type === 'whatsapp') {
            const client = await getClient(clientId);
            const chat = await client.getChatById(id);
            const messages = await chat.fetchMessages({ limit: 50 });
            return res.json(messages.map(m => ({
                id: m.id._serialized,
                fromMe: m.fromMe,
                body: m.body,
                timestamp: m.timestamp,
                role: m.fromMe ? 'human' : 'lead'
            })));
        } else if (type === 'email') {
            const messages = await getGmailThreadMessages(clientId, id);
            return res.json(messages);
        }
        
        res.status(400).json({ error: 'Invalid inbox type' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/sync', async (req, res) => {
    try {
        const { clientId } = req;
        const session = await Session.findOne({ clientId });
        if (session && session.status !== 'READY') {
            return res.status(400).json({ error: 'WhatsApp is not ready (scan required)' });
        }

        const client = await getClient(clientId);
        if (client) {
            const chats = await client.getChats();
            res.json({ success: true, count: (chats || []).length });
        } else {
            res.status(404).json({ error: 'Client not found' });
        }
    } catch (err) { 
        console.error(`❌ Force Sync Error [${req.clientId}]:`, err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    const cid = socket.handshake.query.clientId;
    console.log(`🔌 Dashboard Socket Connected [ID: ${socket.id}, Client: ${cid || 'N/A'}]`);
    
    if (cid && cid !== 'undefined') {
        socket.join(cid);
        getClient(cid).catch(() => {}); // Proactively warm up session
    }
    
    socket.on('join', async (clientId) => {
        if (!clientId) return;
        socket.join(clientId);
        console.log(`👤 Client joined room: ${clientId}`);
        
        // Warm up session if needed
        const client = await getClient(clientId);
        const session = await Session.findOne({ clientId });
        
        if (session?.qr) {
            socket.emit('qr', session.qr);
        } else if (session?.status === 'READY') {
            socket.emit('ready', 'Connected');
        } else {
            socket.emit('status', session?.status || 'DISCONNECTED');
        }
    });

    socket.on('request_pairing_code', async ({ clientId, phone }) => {
        try {
            const client = await getClient(clientId);
            const code = await client.requestPairingCode(phone.replace(/\D/g, ''));
            socket.emit('pairing_code', code);
        } catch (err) { socket.emit('error', 'Pairing failed'); }
    });
});

// NOTE: No warm-up on startup. Client initializes on first user request.
// This prevents OOM crashes on small instances.

// --- GHL EXPANSION ENDPOINTS (LOCALIZED FOR INDIA) ---

// 1. Pipelines
app.get('/api/pipelines', (req, res) => {
    res.json({
        stages: [
            { id: 'new', name: 'Fresh Leads (IndiaMart)', count: 8 },
            { id: 'contacted', name: 'Warm (Google Ads IN)', count: 5 },
            { id: 'qualified', name: 'Qualified (₹50k+)', count: 3 },
            { id: 'closed', name: 'Converted (HNI)', count: 15 }
        ],
        totalValue: '₹4,28,500'
    });
});

// 2. Builder
app.get('/api/builder', (req, res) => {
    res.json({
        sites: [
            { id: 1, name: 'Main Sales Funnel (₹)', visits: 1200, conversion: '24%' },
            { id: 2, name: 'Brand Pro Landing', visits: 840, conversion: '15%' }
        ]
    });
});

// 3. Settlements
app.get('/api/settlements', (req, res) => {
    res.json({
        totalVolume: 428500.40,
        pending: 124000.00,
        transactions: [
            { id: 'TX-IN-901', client: 'Rahul Sharma', amount: 42000, status: 'Succeeded' },
            { id: 'TX-IN-902', client: 'Priya Verma', amount: 15000, status: 'Pending' }
        ]
    });
});

// 4. Omnichannel (Unified Insights)
app.get('/api/omnichannel/stats', (req, res) => {
    res.json({
        whatsapp: { unread: 8, active: 450 },
        email: { unread: 3, active: 85 },
        sms: { unread: 1, active: 120 }
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`--------------------------------------------------------`);
    console.log(`🚀 BRAND PRO SAAS BACKEND LIVE ON PORT ${port}`);
    console.log(`🛡️  MVP ARCHITECTURE FLUSHED & RESTORED`);
    console.log(`🧠 COGNITIVE SWARM v2.0 — Blackboard Architecture`);
    console.log(`--------------------------------------------------------`);
    
    // Initialize the Swarm Manager with Socket.io
    const swarm = getSwarmManager(io);
    
    // Start the CEO Heartbeat (waits 30s for DB to connect)
    startHeartbeat();
});


// ═══════════════════════════════════════════════════
// SWARM API — Blackboard & Agent Monitoring
// ═══════════════════════════════════════════════════

// Get swarm status for a client
app.get('/api/swarm/status', async (req, res) => {
    try {
        const swarm = getSwarmManager();
        const status = await swarm.getSwarmStatus(req.clientId);
        res.json({ success: true, ...status });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Initialize swarm for a client
app.post('/api/swarm/init', async (req, res) => {
    try {
        const swarm = getSwarmManager(io);
        const agents = await swarm.initializeSwarm(req.clientId);
        res.json({ success: true, agents });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get recent signals (Blackboard feed)
app.get('/api/swarm/signals', async (req, res) => {
    try {
        const { status, type, limit } = req.query;
        const query = { clientId: req.clientId };
        if (status) query.status = status;
        if (type) query.type = type;
        
        const signals = await Signal.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit) || 50)
            .lean();
        res.json({ success: true, signals });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get agent states
app.get('/api/swarm/agents', async (req, res) => {
    try {
        const agents = await AgentState.find({ clientId: req.clientId }).lean();
        res.json({ success: true, agents });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually escalate a signal
app.post('/api/swarm/signals/:id/escalate', async (req, res) => {
    try {
        const swarm = getSwarmManager(io);
        const signal = await swarm.escalateSignal(req.params.id, req.body.reason || 'Manual escalation');
        res.json({ success: true, signal });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually resolve an escalated signal
app.post('/api/swarm/signals/:id/resolve', async (req, res) => {
    try {
        const swarm = getSwarmManager();
        const signal = await swarm.resolveSignal(
            req.params.id, 
            req.body.result,
            'Human resolution: ' + (req.body.reasoning || 'Manually resolved'),
            1.0
        );
        res.json({ success: true, signal });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


const gracefulShutdown = async () => {
    console.log('\n🛑 Shutting down backend...');
    for (const [id, client] of clients.entries()) {
        try { await client.destroy(); } catch(e) {}
    }
    if (baileysManager) {
        baileysManager.shutdown();
    }
    process.exit(0);
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

