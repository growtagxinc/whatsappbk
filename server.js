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
const { pushInbound, pushOutbound } = require('./src/lib/queue');
require('./src/lib/worker'); // Start the background worker
const mongoose = require('mongoose'); // Moved up for global log buffer
const { google } = require('googleapis');
const { authMiddleware, issueToken, verifyToken } = require('./src/lib/auth');
const bcrypt = require('bcryptjs');
const { sanitizeAIInput } = require('./ai/sanitize');

// ── WhatsApp Connection Mode ───────────────────────────────────
// USE_BAILEYS=true → Baileys WebSocket mode (QR code, anti-ban protocol)
// USE_BAILEYS=false → Legacy whatsapp-web.js (Puppeteer/Chromium mode)
const USE_BAILEYS = process.env.USE_BAILEYS !== 'false';

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
        // Use the JWT-authenticated userId (set by global auth middleware)
        return req.userId || req.headers['x-workspace-id'] || req.ip || 'unknown';
    },
    handler: (req, res) => {
        console.warn(`[RATE LIMIT] Client ${req.userId} exceeded message rate limit`);
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
    process.stdout.flush?.(); // ensure logs appear immediately
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-id, x-workspace-id, bypass-tunnel-reminder');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});


app.set('trust proxy', 1);
app.use(express.json());

// Cookie parser (for httpOnly JWT cookies)
app.use(require('cookie-parser')());

// 2. Auth & Onboarding Routes
app.use('/api/auth', require('./src/routes/auth-otp'));
app.use('/api/auth', require('./src/routes/auth-user')); // user auth: register, login, logout, me
app.use('/api/onboarding', require('./src/routes/onboarding'));

app.use('/api/tickets', require('./src/routes/tickets'));

// DEBUG: trace what's received on /api/profiles
app.get('/api/profiles', (req, res, next) => {
    const token = (req.cookies && req.cookies.concertos_token) || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    const jwt = require('jsonwebtoken');
    let decoded = null;
    let verifyError = null;
    if (token) {
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        } catch (e) { verifyError = e.message; }
    }
    console.log('[DEBUG /api/profiles] cookies:', JSON.stringify(req.cookies), '| token:', token ? token.substring(0,20)+'...' : 'NULL', '| decoded:', decoded ? decoded.userId : 'FAIL:'+verifyError, '| x-client-id:', req.headers['x-client-id']);
    next();
}, authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        process.stdout.write(`!!!PROF_START!!! uid=${userId}\n`);
        if (mongoose.connection.readyState !== 1) {
            return res.json({ session: { status: 'DISCONNECTED', authenticated: false, qr: null } });
        }
        const session = await Session.findOne({ clientId: userId });
        if (!session) return res.json({ session: { status: 'DISCONNECTED', authenticated: false, qr: null } });

        // Also check if any ws_ session for the same phone or whatsappWid is WhatsApp-connected
        // This catches the case where WhatsApp is connected but the usr_ session wasn't updated
        if (!session.whatsappConnected && (session.phone || session.whatsappWid)) {
            const waSession = await Session.findOne({
                clientId: { $regex: /^ws_/ },
                whatsappConnected: true,
                $or: [
                    session.phone ? { phone: session.phone } : null,
                    session.whatsappWid ? { whatsappWid: { $regex: session.whatsappWid.replace('@c.us', '') } } : null
                ].filter(Boolean)
            }).lean();
            if (waSession) {
                await Session.updateOne(
                    { clientId: userId },
                    { $set: { whatsappConnected: true } }
                ).catch(() => {});
                session.whatsappConnected = true;
            }
        }

        // Verify WhatsApp is actually connected — trust the DB flag + live client presence.
        // ws_ is the stable connected session; usr_'s WhatsApp may be unstable.
        // Chromium DOM inspection is fragile (WhatsApp Web UI changes break selectors),
        // so we trust: clients.has(waClientId) means WhatsApp is running.
        const waSession = await Session.findOne({
            clientId: { $regex: /^ws_/ },
            whatsappConnected: true,
            $or: [
                session.phone ? { phone: session.phone } : null,
                session.whatsappWid ? { whatsappWid: { $regex: session.whatsappWid.replace('@c.us', '') } } : null
            ].filter(Boolean)
        }).lean();
        const waClientId = waSession ? waSession.clientId : userId;

        console.log(`[PROFILES] waSession=${waSession?.clientId} waClientId=${waClientId} clients.has=${clients.has(waClientId)} clients.size=${clients.size} userSession.whatsappConnected=${session.whatsappConnected}`);
        // If ws_ is in DB as connected, trust it. The live client presence check
        // (Chromium running) is enough — don't do fragile DOM inspections.
        if (waSession && !clients.has(waClientId)) {
            // DB says connected but no live client — update and return disconnected
            await Session.updateOne({ clientId: waClientId }, { $set: { whatsappConnected: false, status: 'DISCONNECTED' } }).catch(() => {});
            await Session.updateOne({ clientId: userId }, { $set: { whatsappConnected: false } }).catch(() => {});
            // Emit socket event so frontend updates immediately (not on next 5s poll)
            if (io) io.to(userId).emit('disconnected', 'SESSION_EXPIRED');
            const updated = await Session.findOne({ clientId: userId });
            return res.json({ session: updated });
        }

        // Hybrid WhatsApp status: live Baileys state is primary, DB is fallback
        const baileysStatus = USE_BAILEYS && baileysManager
            ? baileysManager.getStatus(userId)
            : { status: 'NOT_INITIALIZED', connected: false };

        res.json({
            session,
            baileysStatus, // Live Baileys state for real-time accuracy
            whatsappConnected: baileysStatus.connected
                ? true
                : session.whatsappConnected || false,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profiles/init', authMiddleware, async (req, res) => {
    try {
        // ── Role check: only owner can link WhatsApp ─────────────────────────
        if (req.orgId) {
            const member = await OrgMember.findOne({ userId: req.userId, orgId: req.orgId });
            if (!member || member.role !== 'owner') {
                return res.status(403).json({ error: 'Only workspace owner can link WhatsApp' });
            }
        }

        const clientId = req.userId || req.headers['x-client-id'] || 'default';

        // Guard: if already has a QR in DB, don't re-init (prevents QR spam)
        const existingSession = await Session.findOne({ clientId });
        if (existingSession?.qr && existingSession?.status === 'UNAUTHENTICATED') {
            console.log(`[Init] QR already exists for ${clientId}, skipping re-init`);
            return res.json({ success: true, message: "QR already available" });
        }

        if (USE_BAILEYS && baileysManager) {
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

app.post('/api/profiles/logout', authMiddleware, async (req, res) => {
    try {
        // ── Role check: only owner can disconnect WhatsApp ──────────────────
        if (req.orgId) {
            const member = await OrgMember.findOne({ userId: req.userId, orgId: req.orgId });
            if (!member || member.role !== 'owner') {
                return res.status(403).json({ error: 'Only workspace owner can disconnect WhatsApp' });
            }
        }

        const clientId = req.userId || req.headers['x-client-id'] || 'default';
        if (USE_BAILEYS && baileysManager) {
            await baileysManager.destroySession(clientId);
        }
        await purgeClient(clientId);
        res.json({ success: true, message: "Disconnected successfully." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WhatsApp Pairing Code Endpoint ──────────────────────────────────
app.post('/api/profiles/pairing-code', authMiddleware, async (req, res) => {
    try {
        const clientId = req.userId || req.headers['x-client-id'] || 'default';
        const { phoneNumber, code } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'phoneNumber is required' });
        }

        if (!USE_BAILEYS || !baileysManager) {
            return res.status(503).json({ error: 'Baileys mode not enabled' });
        }

        // Validate phone format (basic: must have digits and start with +)
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        if (cleanPhone.length < 10) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }

        // Validate optional 8-char code
        if (code && !/^\d{8}$/.test(code)) {
            return res.status(400).json({ error: 'Pairing code must be exactly 8 digits' });
        }

        console.log(`[PairingCode API] ${clientId} requesting code for ${phoneNumber}`);
        const pairingCode = await baileysManager.requestPairingCode(clientId, phoneNumber, code);

        res.json({ success: true, pairingCode });
    } catch (err) {
        console.error(`[PairingCode API] Error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
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
        if (!baileysManager) return res.status(503).json({ error: "Baileys not enabled" });
        const info = baileysManager.getStatus(req.clientId || req.headers['x-client-id'] || 'default');
        res.json(info);
    });
    
    // New endpoint for connection statistics
    app.get('/api/baileys/stats', async (req, res) => {
        if (!baileysManager) return res.status(503).json({ error: "Baileys not enabled" });
        const stats = baileysManager.getStats();
        res.json(stats);
    });
}

// Verify a token (useful for dashboard health check)
app.get('/api/auth/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false });
    }
    const decoded = verifyToken(authHeader.slice(7));
    if (decoded) {
        // Backward compat: old tokens had clientId, new ones have userId
        res.json({ valid: true, clientId: decoded.userId || decoded.clientId });
    } else {
        res.status(401).json({ valid: false });
    }
});

// ── Google OAuth Routes ──────────────────────────────────────
const GOOGLE_CALLBACK = 'https://engine.brandproinc.in/api/auth/google/callback';

// Helper: get the real protocol behind Cloudflare proxy
function getRealProtocol(req) {
    const forwardedProto = req.get('X-Forwarded-Proto');
    return forwardedProto || req.protocol;
}

app.get('/auth/google', (req, res) => {
    const clientId = req.query.clientId || 'default';
    const state = Buffer.from(JSON.stringify({ clientId })).toString('base64');

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_SCOPES,
        state: state,
        prompt: 'consent',
        redirect_uri: GOOGLE_CALLBACK
    });
    res.redirect(url);
});

app.get('/api/google/link', (req, res) => {
    const clientId = req.query.clientId || 'default';
    const state = Buffer.from(JSON.stringify({ clientId, action: 'link' })).toString('base64');

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: GOOGLE_SCOPES,
        state: state,
        prompt: 'consent',
        redirect_uri: GOOGLE_CALLBACK
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
        // Use the same redirect URI that was used in the auth URL
        const { tokens } = await oauth2Client.getToken(code, { redirect_uri: GOOGLE_CALLBACK });
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        const email = userInfo.data.email;
        const displayName = userInfo.data.name || email;

        // Update Session (backward compat)
        await Session.findOneAndUpdate(
            { clientId },
            {
                googleTokens: tokens,
                googleEmail: email,
                email: email,
                displayName: displayName,
                authenticated: true
            },
            { upsert: true }
        );

        // Update User (canonical source of truth for Google tokens)
        await User.findOneAndUpdate(
            { email },
            {
                googleTokens: tokens,
                googleEmail: email,
                email: email,
                displayName: displayName,
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

        const { tokens } = await oauth2Client.getToken(code, { redirect_uri: GOOGLE_CALLBACK });
        oauth2Client.setCredentials(tokens);

        // Fetch user info
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        // Update session with tokens (backward compat)
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

        // Update User model (canonical source of truth)
        await User.findOneAndUpdate(
            { email: userInfo.data.email },
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

app.post('/api/google/unlink', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        await Session.findOneAndUpdate(
            { workspaceId },
            { $unset: { googleTokens: '', googleEmail: '' } }
        );
        res.json({ success: true, message: 'Google account unlinked.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unlink Google account.' });
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

// Make io accessible to routes via req.app.get('io')
app.set('io', io);


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
const User = require('./models/User');
const Organisation = require('./models/Organisation');
const Inventory = require('./models/Inventory');
const Order = require('./models/Order');
const Task = require('./models/Task');
const Service = require('./models/Service');
const Appointment = require('./models/Appointment');
const AgentState = require('./models/AgentState');
const OrgMember = require('./models/OrgMember');
const Workspace = require('./models/Workspace');
const Chat = require('./models/Chat');
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
        // Try to get workspaceId/orgId from an existing session to preserve them
        const existing = await Session.findOne({ clientId }).select('workspaceId orgId userId phone email').lean();
        const setFields = {
            ...updates,
            lastActive: new Date(),
            ...(existing ? { workspaceId: existing.workspaceId, orgId: existing.orgId } : {}),
        };
        const updated = await Session.findOneAndUpdate(
            { clientId },
            { $set: setFields },
            { upsert: true, new: true }
        );

        // If WhatsAppConnected changed, also sync the user's main session (usr_) so the
        // dashboard (which reads the usr_ session) sees the correct WhatsApp status.
        // Link via phone or email from the updated session.
        if (updates.whatsappConnected !== undefined && existing) {
            const identifier = existing.phone || existing.email;
            if (identifier) {
                await Session.updateMany(
                    {
                        clientId: { $ne: clientId },
                        $or: [
                            { phone: identifier },
                            { email: identifier }
                        ]
                    },
                    { $set: { whatsappConnected: updates.whatsappConnected, lastActive: new Date() } }
                ).catch(() => {});
            }
        }

        return updated;
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

// Helper: upsert chat metadata whenever a message is sent/received
async function upsertChat(clientId, wid, name, body, timestamp, fromMe = false, pinned = false) {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const chatId = `${clientId}:${wid}`;
        await Chat.findOneAndUpdate(
            { chatId },
            {
                $set: {
                    chatId,
                    clientId,
                    wid,
                    name: name || wid.replace('@c.us', '').replace('@g.us', ''),
                    type: wid.endsWith('@g.us') ? 'group' : 'chat',
                    lastMessage: body || '',
                    lastMessageId: '',
                    lastMessageFromMe: !!fromMe,
                    lastInteraction: timestamp || Math.floor(Date.now() / 1000),
                    isActive: true,
                    pinned: !!pinned,
                },
                $inc: { unread: fromMe ? 0 : 1 }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    } catch (e) {
        console.log(`[Chat] upsertChat error: ${e.message}`);
    }
}

// Helper to get or create a client for a specific user (QR Onboarding)
// ── Baileys Mode: delegates to WhatsAppManager (direct WebSockets) ────────
async function getClient(clientId) {
    if (!clientId) return null;

    // Guard: prevent duplicate initializations (Puppeteer mode)
    if (!USE_BAILEYS && clients.has(clientId)) {
        const existingClient = clients.get(clientId);
        // Sanity-check: verify Chromium is still alive before reusing.
        // Container restart kills Chromium; dead clients must be purged so they reinitialize.
        if (existingClient && existingClient.pupPage) {
            try {
                await Promise.race([
                    existingClient.pupPage.evaluate(() => document.readyState),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('pup_dead')), 2000))
                ]);
                console.log(`[Puppeteer] Reusing existing client for ${clientId}`);
                return existingClient;
            } catch (_) {
                // Chromium is dead — purge and reinitialize
                console.warn(`[Puppeteer] Cached client for ${clientId} is dead (Chromium gone). Purging.`);
                clients.delete(clientId);
                existingClient.destroy().catch(() => {});
            }
        } else if (existingClient) {
            clients.delete(clientId);
            existingClient.destroy().catch(() => {});
        }
    }
    if (!USE_BAILEYS && pendingInits.has(clientId)) {
        console.log(`[Puppeteer] Init already in progress for ${clientId}, waiting...`);
        return pendingInits.get(clientId);
    }

    // Baileys WebSocket mode — use WhatsAppManager directly
    if (USE_BAILEYS && baileysManager) {
        // Implement retry mechanism with backoff for Baileys
        let attempts = 0;
        const maxAttempts = 3;
        while (attempts < maxAttempts) {
            try {
                return await baileysManager.wakeClient(clientId);
            } catch (err) {
                attempts++;
                console.warn(`[Baileys] Wake client attempt ${attempts} failed for ${clientId}:`, err.message);
                if (attempts < maxAttempts) {
                    // Exponential backoff: 1s, 2s, 4s
                    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts - 1) * 1000));
                } else {
                    throw err; // Re-throw on final attempt
                }
            }
        }
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
                if (errMsg.includes('already running') || errMsg.includes('profile appears to be in use') || errMsg.includes('Code: 21') || errMsg.includes('LifecycleWatcher disposed')) {
                    console.warn(`⚠️ Session corrupted (${errMsg.substring(0, 60)}). Wiping session dir and retrying for ${clientId}...`);
                    // Destroy current client and wipe session dir
                    try { client.destroy(); } catch (_) {}
                    clients.delete(clientId);
                    try { require('fs').rmSync(dataPath, { recursive: true, force: true }); } catch (_) {}
                    // Create a completely fresh client
                    const newClient = new Client({
                        authStrategy: new LocalAuth({ clientId, dataPath }),
                        puppeteer: {
                            headless: 'new',
                            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu']
                        }
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
        // bufferCommands=false throws if called before mongoose.connect() finishes
        // Skip silently — MongoDB will be fully ready on the next interval tick
        if (err.message.includes('bufferCommands') || err.message.includes('initial connection')) {
            return;
        }
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
        const info = client.info || {};
        const waWid = info.wid?._serialized || '';
        await updateSessionState(clientId, {
            authenticated: true,
            status: 'AUTHENTICATED',
            whatsappConnected: true,
            qr: null,
            phone: info.wid?.user || '',
            whatsappWid: waWid
        });
        console.log(`🔒 Identity Verified for ${clientId}`);
    });

    client.on('ready', async () => {
        const info = client.info || {};
        const waWid = info.wid?._serialized || '';
        await updateSessionState(clientId, {
            status: 'READY',
            authenticated: true,
            whatsappConnected: true,
            qr: null,
            displayName: info.pushname || '',
            phone: info.wid?.user || '',
            whatsappWid: waWid
        });
        // Sync whatsappConnected=true to all user sessions sharing the same WhatsApp phone.
        // Also find and update the usr_ session directly (it may not have phone set).
        const waPhone = info.wid?.user || '';
        if (waPhone || waWid) {
            await Session.updateMany(
                { clientId: { $ne: clientId }, phone: waPhone },
                { $set: { whatsappConnected: true, lastActive: new Date() } }
            ).catch(() => {});
        }
        // Also update the companion usr_ session directly (different clientId prefix)
        // by finding sessions in the same org that don't have ws_ prefix
        if (clientId.startsWith('ws_')) {
            const usrSession = await Session.findOne({
                clientId: { $regex: /^usr_/ },
                whatsappConnected: { $ne: true }
            }).lean();
            if (usrSession) {
                await Session.updateOne(
                    { _id: usrSession._id },
                    { $set: { whatsappConnected: true, phone: waPhone || '', whatsappWid: waWid, lastActive: new Date() } }
                ).catch(() => {});
            }
        }

        console.log(`✅ DASHBOARD READY for ${clientId}`);

        // Auto-Initialize Cognitive Swarm for this client
        try {
            const swarm = require('./swarm/SwarmManager').getSwarmManager(io);
            await swarm.initializeSwarm(clientId);
        } catch (err) {
            console.error(`[SWARM] Auto-init failed to initialize agents for ${clientId}:`, err.message);
        }
        
        io.to(clientId).emit('ready', 'Connected');

        // Heartbeat: verify WhatsApp Web page is still connected every 60s
        // WhatsApp Web shows "Phone not connected" or QR when session expires
        const pupPage = client.pupPage;
        if (!client._waHeartbeatInterval && pupPage) {
            client._waHeartbeatInterval = setInterval(async () => {
                try {
                    const isStillConnected = await pupPage.evaluate(() => {
                        const text = document.body ? (document.body.innerText || '') : '';
                        const hasQR = document.querySelector('.qr-login-container, [data-ref="qr-code"]');
                        const hasPhoneNotConnected = text.includes('phone is not connected') || text.includes('connect your phone');
                        return !hasQR && !hasPhoneNotConnected;
                    }).catch(() => true);
                    if (!isStillConnected) {
                        console.warn(`[Heartbeat] WhatsApp Web session expired for ${clientId} — triggering disconnect`);
                        client.emit('disconnected', 'SESSION_EXPIRED');
                    }
                } catch (e) { /* ignore */ }
            }, 60000);
        }
    });

    client.on('auth_failure', async msg => {
        console.warn(`🛑 Auth Failure [${clientId}]: ${msg}`);
        await updateSessionState(clientId, { status: 'AUTH_FAILURE', qr: null, authenticated: false });
        io.to(clientId).emit('error', 'Auth failure: ' + msg);
        setTimeout(() => purgeClient(clientId), 500);
    });

    client.on('disconnected', async (reason) => {
        console.warn(`🔌 Disconnected [${clientId}]: ${reason}`);
        // Only mark as DISCONNECTED if the heartbeat confirmed a real session expiry.
        // Puppeteer fires 'disconnected' during normal session restore — heartbeat
        // is the authoritative source of truth for real disconnects (emits SESSION_EXPIRED).
        const isRealDisconnect = reason === 'SESSION_EXPIRED';
        const updates = { authenticated: false };
        if (isRealDisconnect) {
            updates.status = 'DISCONNECTED';
            updates.whatsappConnected = false;
        }
        await updateSessionState(clientId, updates);
        io.to(clientId).emit('disconnected', reason);
        if (isRealDisconnect) {
            setTimeout(() => purgeClient(clientId), 500);
        }
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

        // Persist chat metadata to MongoDB for inbox
        const contactName = msg.notifyName || msg._data?.notifyName || msg.from.replace('@c.us', '').replace('@g.us', '');
        await upsertChat(clientId, msg.from, contactName, msg.body, msg.timestamp, false);

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
                    await upsertChat(clientId, chatId, '', aiReply.response, Math.floor(Date.now() / 1000), true);
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
    '/api/google'
];

app.use(async (req, res, next) => {
    if (req.path === '/' || PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();

    // Apply JWT auth middleware inline (same logic as authMiddleware but properly awaited)
    const token = req.cookies?.concertos_token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Unauthorized: No token' });

    const jwt = require('/app/node_modules/jsonwebtoken');
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], clockTolerance: 30 });
    } catch (err) {
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    req.userId = decoded.userId || decoded.clientId || null;
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized: Token missing userId' });
    req.orgId = decoded.orgId || null;
    req.workspaceId = req.headers['x-workspace-id'] || decoded.workspaceId || null;
    req.clientId = req.userId;

    // WhatsApp clients are stored by userId in WhatsAppManager — wait for client to be resolved
    if (!req.userId) {
        req.whatsapp = null;
        return next();
    }
    try {
        req.whatsapp = await getClient(req.userId);
    } catch (err) {
        req.whatsapp = null;
    }

    next();
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
            return res.json({ status: 'UP', whatsapp: 'DISCONNECTED(DB_DOWN)', hasActiveQR: false, userName: null, isLoaded: false, paperclip: false, baileys: USE_BAILEYS });
        }

        // QR-based WhatsApp connection (Baileys or Puppeteer)
        const whatsappStatus = session ? session.status : 'DISCONNECTED';

        res.json({
            status: 'UP',
            whatsapp: whatsappStatus,
            hasActiveQR: !!(session && session.qr),
            userName: null,
            isLoaded: !!clients.get(clientId),
            paperclip: false,
            baileys: USE_BAILEYS ? baileysManager?.getStatus(clientId) : null,
        });
    } catch (e) {
        res.json({ status: 'UP', whatsapp: 'DISCONNECTED(ERR)', hasActiveQR: false, userName: null, isLoaded: false, paperclip: false, baileys: USE_BAILEYS });
    }
});

app.get('/api/chats', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.json({ chats: [], whatsappStatus: 'DISCONNECTED' });
        }

        const userId = req.userId;
        const session = await Session.findOne({ clientId: userId }).lean();
        const status = session ? session.status : 'AUTHENTICATING';

        // Resolve ws_ session for WhatsApp operations
        const phone = session?.phone;
        let waClientId = userId;
        if (phone) {
            const waSession = await Session.findOne({
                clientId: { $regex: /^ws_/ },
                $or: [
                    { phone: phone },
                    { whatsappWid: { $regex: phone + '@' } }
                ],
                whatsappConnected: true
            }).lean();
            if (waSession) waClientId = waSession.clientId;
        }

        const client = await getClient(waClientId);

        if (!client || status !== 'READY') {
             return res.json({ chats: [], whatsappStatus: status });
        }

        let chats = [];
        try {
            chats = await client.getChats();
        } catch (e) {
            console.warn(`[${waClientId}] getChats failed despite READY status:`, e.message);
            return res.json({ chats: [], whatsappStatus: 'CONNECTING' });
        }

        const enriched = chats.map((chat) => ({
            id: chat.id._serialized,
            name: chat.name,
            unreadCount: chat.unreadCount,
            lastMessage: chat.lastMessage ? chat.lastMessage.body : '',
            profilePic: null,
            pinned: !!chat.pinned
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

// Mark chat messages as read
app.post('/api/chats/:id/read', async (req, res) => {
    const userId = req.userId;
    try {
        // Resolve ws_ session for WhatsApp operations
        const session = await Session.findOne({ clientId: userId }).lean();
        const phone = session?.phone;
        let waClientId = userId;
        if (phone) {
            const waSession = await Session.findOne({
                clientId: { $regex: /^ws_/ },
                $or: [
                    { phone: phone },
                    { whatsappWid: { $regex: phone + '@' } }
                ],
                whatsappConnected: true
            }).lean();
            if (waSession) waClientId = waSession.clientId;
        }

        const client = await getClient(waClientId);
        if (!client) return res.status(503).json({ error: "WhatsApp not ready" });

        const chat = await client.getChatById(req.params.id);
        await chat.sendSeen();

        // Clear unread count in MongoDB so UI reflects read state
        const wid = req.params.id;
        await Chat.updateOne(
            { clientId: waClientId, wid },
            { $set: { unread: 0 } }
        ).catch(() => {});

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deprecated GET /api/chats/:id/messages — use /api/inbox/whatsapp/:id/messages instead
// (Frontend already uses the inbox endpoint; this is kept for backwards compat)
app.get('/api/chats/:id/messages', async (req, res) => {
    res.status(410).json({
        error: "This endpoint is deprecated. Use GET /api/inbox/whatsapp/" + req.params.id + "/messages",
        code: "DEPRECATED_ENDPOINT"
    });
});


app.post('/api/chats/:id/messages', messageRateLimiter, async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const { text, quotedMsgId } = req.body;
        if (!text) return res.status(400).json({ error: "Message text required" });

        const options = {};
        if (quotedMsgId) {
            // Fetch the message to reply to
            try {
                const chat = await client.getChatById(req.params.id);
                const allMsgs = await chat.fetchMessages({ limit: 100 });
                const quotedMsg = allMsgs.find(m => m.id._serialized === quotedMsgId);
                if (quotedMsg) {
                    // Build ChatMessage to reply to
                    const { Chat, Message } = require('/app/node_modules/whatsapp-web.js');
                    const quoted = Message.createFromData(quotedMsg);
                    options['quotedMessageId'] = quotedMsgId;
                }
            } catch(e) {
                console.log(`[Send] Could not find quoted message ${quotedMsgId}: ${e.message}`);
            }
        }

        if (USE_BAILEYS && baileysManager) {
            await baileysManager.sendSafeReply(req.clientId, req.params.id, text, quotedMsgId);
        } else {
            // whatsapp-web.js (Puppeteer) mode — sendMessage with quotedMessageId
            await client.sendMessage(req.params.id, text, options);
        }
        // Persist outbound message to MongoDB for inbox
        await upsertChat(req.clientId, req.params.id, '', text, Math.floor(Date.now() / 1000), true);
        res.json({ success: true, timestamp: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PROFILES & SETTINGS
app.get('/api/profile', authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;

        // Fetch Session and User in parallel
        const [session, user] = await Promise.all([
            Session.findOne({ clientId: userId }),
            User.findOne({ clientId: userId }).select('phone displayName email').lean(),
        ]);

        let profile = {
            // Canonical phone from User (primary source), fall back to Session or WhatsApp
            phone: user?.phone || session?.phone || '',
            displayName: user?.displayName || session?.displayName || '',
            email: user?.email || session?.email || '',
            bio: session?.bio || '',
            status: session?.status || 'DISCONNECTED',
            company: session?.company || '',
            sector: session?.sector || '',
            vertical: session?.vertical || '',
            workspaceName: session?.workspaceName || '',
            googleEmail: session?.googleEmail || null,
            googleLinked: !!(session?.googleTokens && session?.googleTokens.access_token),
        };

        const client = req.whatsapp;
        if (client && client.info) {
            profile.whatsappSynced = true;
            profile.pushname = client.info.pushname;
            profile.phone = client.info.wid?.user;  // WhatsApp-specific phone overrides
        }

        // Baileys mode: add WebSocket session info
        if (USE_BAILEYS && baileysManager) {
            profile.baileys = baileysManager.getStatus(userId);
        }

        res.json(profile);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Duplicates removed (moved to top for better accessibility)


app.post('/api/profile', authMiddleware, async (req, res) => {
    try {
        const { email, displayName, bio, phone, company } = req.body;
        const userId = req.userId;

        // Build partial update — only include fields present in body
        const sessionUpdates = {};
        if (email !== undefined) sessionUpdates.email = email;
        if (displayName !== undefined) sessionUpdates.displayName = displayName;
        if (bio !== undefined) sessionUpdates.bio = bio;
        if (phone !== undefined) sessionUpdates.phone = phone;
        if (company !== undefined) sessionUpdates.company = company;

        await Session.findOneAndUpdate(
            { clientId: userId },
            { $set: sessionUpdates },
            { upsert: true, returnDocument: 'after' }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages/send', messageRateLimiter, async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const { chatId, message, quotedMessageId } = req.body;
        if (USE_BAILEYS && baileysManager) {
            await baileysManager.sendSafeReply(req.clientId, chatId, message, { quotedKey: quotedMessageId });
        } else {
            await client.sendMessage(chatId, message, { quotedMessageId });
        }
        await upsertChat(req.clientId, chatId, '', message, Math.floor(Date.now() / 1000), true);
        res.json({ success: true, timestamp: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/chats/:id/messages/:msgId — Delete for everyone
app.delete('/api/chats/:id/messages/:msgId', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not connected" });
    try {
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 200 });
        const msg = messages.find(m => m.id._serialized === req.params.msgId);
        if (!msg) return res.status(404).json({ error: "Message not found", code: 'MSG_NOT_FOUND' });
        if (!msg.fromMe) return res.status(403).json({ error: "Can only delete your own messages", code: 'NOT_YOUR_MESSAGE' });
        await msg.delete(true);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to delete message", code: 'DELETE_FAILED' }); }
});

// PUT /api/chats/:id/messages/:msgId — Edit sent message (within ~15 min window)
app.put('/api/chats/:id/messages/:msgId', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not connected" });
    try {
        const { text } = req.body;
        if (!text) return res.status(400).json({ error: "Message text required", code: 'MISSING_TEXT' });
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 200 });
        const msg = messages.find(m => m.id._serialized === req.params.msgId);
        if (!msg) return res.status(404).json({ error: "Message not found or too old", code: 'MSG_NOT_FOUND' });
        if (!msg.fromMe) return res.status(403).json({ error: "Can only edit your own messages", code: 'NOT_YOUR_MESSAGE' });

        // Time-window check: WhatsApp only allows edits within ~15 minutes
        const nowSecs = Math.floor(Date.now() / 1000);
        if ((nowSecs - msg.timestamp) > 15 * 60) {
            return res.status(410).json({ error: "Edit window has expired (15 min)", code: 'EDIT_WINDOW_EXPIRED' });
        }

        await msg.edit(text);
        res.json({ success: true });
    } catch (err) {
        const msg = err.message || '';
        if (msg.includes('too old') || msg.includes('cannot be edited') || msg.includes('81002')) {
            return res.status(410).json({ error: "Edit window has expired", code: 'EDIT_WINDOW_EXPIRED' });
        }
        res.status(500).json({ error: err.message, code: 'EDIT_FAILED' });
    }
});

// POST /api/chats/:id/messages/:msgId/star — Star or unstar a message
app.post('/api/chats/:id/messages/:msgId/star', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not connected" });
    try {
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 200 });
        const msg = messages.find(m => m.id._serialized === req.params.msgId);
        if (!msg) return res.status(404).json({ error: "Message not found", code: 'MSG_NOT_FOUND' });
        const isStarred = !!(msg._data?.star);
        if (isStarred) {
            await msg.unstar();
        } else {
            await msg.star();
        }
        res.json({ success: true, isStarred: !isStarred });
    } catch (err) { res.status(500).json({ error: "Failed to star message", code: 'STAR_FAILED' }); }
});

// POST /api/chats/:id/messages/:msgId/react — React to a message with emoji
app.post('/api/chats/:id/messages/:msgId/react', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not connected" });
    try {
        const { emoji } = req.body;
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 200 });
        const msg = messages.find(m => m.id._serialized === req.params.msgId);
        if (!msg) return res.status(404).json({ error: "Message not found", code: 'MSG_NOT_FOUND' });
        await msg.react(emoji || '👍');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to react", code: 'REACT_FAILED' }); }
});

// POST /api/chats/:id/forward — Forward one or more messages to one or more chats
app.post('/api/chats/:id/forward', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not connected" });
    try {
        const { messageIds, targetChatIds } = req.body;
        if (!messageIds?.length || !targetChatIds?.length) {
            return res.status(400).json({ error: "Select at least one message and one chat", code: 'MISSING_SELECTION' });
        }
        if (targetChatIds.length > 5) {
            return res.status(400).json({ error: "Maximum 5 chats at a time", code: 'TOO_MANY_TARGETS' });
        }
        const sourceChat = await client.getChatById(req.params.id);
        const allMsgs = await sourceChat.fetchMessages({ limit: 200 });
        const toForward = allMsgs.filter(m => messageIds.includes(m.id._serialized));
        if (!toForward.length) return res.status(404).json({ error: "Messages not found", code: 'MSGS_NOT_FOUND' });

        const results = [];
        for (const targetId of targetChatIds) {
            try {
                for (const msg of toForward) {
                    await client.forwardMessage(targetId, msg);
                }
                results.push({ chatId: targetId, success: true });
            } catch(e) {
                results.push({ chatId: targetId, success: false, error: e.message });
            }
        }
        const failed = results.filter(r => !r.success).length;
        res.json({
            success: failed === 0,
            partial: failed > 0 && failed < targetChatIds.length,
            results
        });
    } catch (err) { res.status(500).json({ error: "Failed to forward", code: 'FORWARD_FAILED' }); }
});

// PATCH /api/chats/:id — Update chat settings (archive, mute, pin, mark unread)
app.patch('/api/chats/:id', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const { archive, mute, pin, markUnread } = req.body;
        const chat = await client.getChatById(req.params.id);
        if (archive !== undefined) await chat.archive(archive);
        if (mute !== undefined) {
            if (mute === 0) await chat.unmute();
            else await chat.mute(mute); // mute takes a Duration
        }
        if (pin !== undefined) await chat.pin(pin);
        if (markUnread !== undefined) {
            if (markUnread) await chat.sendSeen(false);
            // Note: sendSeen(false) marks as unread in wweb.js
        }
        // Sync back to MongoDB
        await Chat.findOneAndUpdate(
            { clientId: req.clientId, wid: req.params.id },
            {
                $set: {
                    isActive: !archive
                }
            }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post('/api/chats/:id/force-ai', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not ready" });
    try {
        const chat = await client.getChatById(req.params.id);
        const messages = await chat.fetchMessages({ limit: 30 });
        const reversed = messages.reverse();

        const textMessages = reversed.filter(m => !m.fromMe && m.body).map(m => m.body);
        const imageMsgs = reversed.filter(m => !m.fromMe && m.hasMedia && m.type === 'image').slice(0, 3);

        if (textMessages.length === 0 && imageMsgs.length === 0) {
            return res.status(400).json({ error: "No user messages found to evaluate." });
        }

        // Lazy image download: one at a time with 8s timeout each, cap at 2 images
        const downloadImg = async (msg) => {
            return Promise.race([
                (async () => {
                    const media = await msg.downloadMedia();
                    return media ? `data:${media.mimetype};base64,${media.data}` : null;
                })(),
                new Promise(r => setTimeout(() => r(null), 8000))
            ]).catch(() => null);
        };

        const allImages = [];
        for (const img of imageMsgs) {
            const data = await downloadImg(img);
            if (data) allImages.push(data);
            if (allImages.length >= 2) break;
        }

        const bodyText = textMessages.length > 0 ? textMessages.slice(0, 5).join('\n---\n') : 'Evaluate profile.';

        const context = await determineIntent(bodyText);
        let auditData = null;
        let detectedUrl = context.profileUrl;

        if (!detectedUrl && allImages.length > 0) {
            try {
                const visionResult = await Promise.race([
                    handleVision(allImages, "Find social profile URL."),
                    new Promise((_, rj) => setTimeout(() => rj(new Error('vision_timeout')), 15000))
                ]);
                if (visionResult?.profileUrl) detectedUrl = visionResult.profileUrl;
            } catch (_) {}
        }

        if (detectedUrl) {
            try {
                await client.sendMessage(chat.id._serialized, "🔍 Processing audit...");
                const auditResult = await auditProfile(detectedUrl);
                if (auditResult && auditResult.success) {
                    auditData = auditResult.data;
                    const phone = chat.id._serialized.replace('@c.us', '');
                    await Lead.findOneAndUpdate(
                        { phone, clientId: req.userId },
                        { auditData, lastAuditedAt: new Date(), clientId: req.userId },
                        { upsert: true }
                    );
                }
            } catch (_) {}
        }

        const aiReply = await processMessage(bodyText, allImages.length > 0 ? allImages : null, auditData);
        if (aiReply?.response) {
            await client.sendMessage(chat.id._serialized, aiReply.response);
            res.json({ success: true, aiResponse: aiReply.response });
        } else {
            res.status(500).json({ error: "AI failed to generate a response" });
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
            // Don't auto-create with generic "Contact" name — return empty so frontend
            // uses the chat name from the Chat model or phone number instead
            return res.json({
                phone,
                name: null,
                tags: [],
                assignedAgent: null,
                isAiPaused: false,
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

// Update ticket status (frontend calls this as POST /tickets/:id/status)
app.post('/api/tickets/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        if (!status) return res.status(400).json({ error: 'status is required' });
        const updated = await Ticket.findOneAndUpdate(
            { clientId: req.clientId, ticketId: req.params.id },
            { $set: { status } },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Ticket not found' });
        io.to(req.clientId).emit('ticket_updated', updated);
        res.json({ success: true, ticket: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory API ─────────────────────────────────────────────────
app.get('/api/inventory', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { category, status } = req.query;
        const filter = { workspaceId };
        if (category && category !== 'All') filter.category = category;
        if (status) filter.status = status;
        const items = await Inventory.find(filter).sort({ name: 1 });
        res.json({ success: true, items });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const { name, sku, category, stock, minStock, price, unit } = req.body;
        const productId = 'INV-' + Date.now().toString(36).toUpperCase();
        let status = 'healthy';
        if (stock === 0) status = 'out';
        else if (stock < minStock) status = 'low';
        const item = await Inventory.create({
            workspaceId,
            orgId,
            productId,
            name,
            sku,
            category: category || 'General',
            stock: stock || 0,
            minStock: minStock || 0,
            price: price || 0,
            unit: unit || 'pcs',
            status
        });
        io.to(workspaceId).emit('inventory_updated', item);
        res.json({ success: true, item });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventory/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Inventory.findOneAndUpdate(
            { workspaceId, productId: req.params.id },
            { $set: req.body },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Product not found' });
        io.to(workspaceId).emit('inventory_updated', updated);
        res.json({ success: true, item: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/inventory/:id/stock', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { adjustment } = req.body; // positive or negative number
        const item = await Inventory.findOne({ workspaceId, productId: req.params.id });
        if (!item) return res.status(404).json({ error: 'Product not found' });
        item.stock = Math.max(0, item.stock + adjustment);
        await item.save(); // triggers status auto-compute

        // Emit low-stock signal if below threshold
        if (item.status === 'low' || item.status === 'out') {
            const swarm = require('./swarm/SwarmManager').getSwarmManager(io);
            await swarm.postSignal('INVENTORY_LOW', {
                productId: item.productId,
                name: item.name,
                stock: item.stock,
                minStock: item.minStock,
                status: item.status
            }, workspaceId, { source: 'inventory' });
        }

        io.to(workspaceId).emit('inventory_updated', item);
        res.json({ success: true, item });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/inventory/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const deleted = await Inventory.findOneAndDelete({ workspaceId, productId: req.params.id });
        if (!deleted) return res.status(404).json({ error: 'Product not found' });
        io.to(workspaceId).emit('inventory_deleted', { productId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Orders API ────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { stage } = req.query;
        const filter = { workspaceId };
        if (stage) filter.stage = stage;
        const orders = await Order.find(filter).sort({ createdAt: -1 });
        res.json({ success: true, orders });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const orderId = 'ORD-' + Date.now().toString(36).toUpperCase();
        const { customerName, company, phone, items, stage, notes } = req.body;
        const order = await Order.create({
            workspaceId,
            orgId,
            orderId,
            customerName: customerName || 'Unknown',
            company: company || '',
            phone: phone || '',
            items: items || [],
            stage: stage || 'draft',
            notes: notes || ''
        });

        // Emit ORDER_CREATED signal
        const swarm = require('./swarm/SwarmManager').getSwarmManager(io);
        await swarm.postSignal('ORDER_CREATED', {
            orderId: order.orderId,
            customerName: order.customerName,
            totalAmount: order.totalAmount,
            stage: order.stage
        }, workspaceId, { source: 'orders' });

        io.to(workspaceId).emit('order_updated', order);
        res.json({ success: true, order });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Order.findOneAndUpdate(
            { workspaceId, orderId: req.params.id },
            { $set: req.body },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Order not found' });
        io.to(workspaceId).emit('order_updated', updated);
        res.json({ success: true, order: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const deleted = await Order.findOneAndDelete({ workspaceId, orderId: req.params.id });
        if (!deleted) return res.status(404).json({ error: 'Order not found' });
        io.to(workspaceId).emit('order_deleted', { orderId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tasks API ─────────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { assigneeId, status } = req.query;
        const filter = { workspaceId };
        if (assigneeId) filter.assigneeId = assigneeId;
        if (status) filter.status = status;
        const tasks = await Task.find(filter).sort({ priority: 1, dueDate: 1 });
        res.json({ success: true, tasks });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const taskId = 'TSK-' + Date.now().toString(36).toUpperCase();
        const { title, description, priority, assigneeId, assigneeName, dueDate, vertical } = req.body;
        const task = await Task.create({
            workspaceId,
            orgId,
            taskId,
            title,
            description: description || '',
            priority: priority || 'Medium',
            status: 'todo',
            assigneeId: assigneeId || workspaceId,
            assigneeName: assigneeName || '',
            dueDate: dueDate ? new Date(dueDate) : null,
            vertical: vertical || 'General',
            createdBy: workspaceId
        });
        io.to(workspaceId).emit('task_updated', task);
        res.json({ success: true, task });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Task.findOneAndUpdate(
            { workspaceId, taskId: req.params.id },
            { $set: req.body },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Task not found' });
        io.to(workspaceId).emit('task_updated', updated);
        res.json({ success: true, task: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const deleted = await Task.findOneAndDelete({ workspaceId, taskId: req.params.id });
        if (!deleted) return res.status(404).json({ error: 'Task not found' });
        io.to(workspaceId).emit('task_deleted', { taskId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Services API ─────────────────────────────────────────────────
app.get('/api/services', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const services = await Service.find({ workspaceId }).sort({ name: 1 });
        res.json({ success: true, services });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/services', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const serviceId = 'SVC-' + Date.now().toString(36).toUpperCase();
        const svc = await Service.create({ ...req.body, workspaceId, orgId, serviceId });
        io.to(workspaceId).emit('service_updated', svc);
        res.json({ success: true, service: svc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/services/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Service.findOneAndUpdate(
            { workspaceId, serviceId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Service not found' });
        io.to(workspaceId).emit('service_updated', updated);
        res.json({ success: true, service: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/services/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        await Service.findOneAndDelete({ workspaceId, serviceId: req.params.id });
        io.to(workspaceId).emit('service_deleted', { serviceId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Appointments API ─────────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { date, status } = req.query;
        const filter = { workspaceId };
        if (date) filter.date = { $gte: new Date(date), $lt: new Date(new Date(date).getTime() + 86400000) };
        if (status) filter.status = status;
        const appointments = await Appointment.find(filter).sort({ date: 1, timeSlot: 1 });
        res.json({ success: true, appointments });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const appointmentId = 'APT-' + Date.now().toString(36).toUpperCase();
        const { serviceId, serviceName, customerName, phone, date, timeSlot, amount, notes } = req.body;

        // Check availability — no double-booking same slot
        const existing = await Appointment.findOne({
            workspaceId,
            date: { $gte: new Date(date), $lt: new Date(new Date(date).getTime() + 86400000) },
            timeSlot,
            status: { $ne: 'cancelled' }
        });
        if (existing) return res.status(409).json({ error: 'This time slot is already booked' });

        const apt = await Appointment.create({
            workspaceId, orgId, appointmentId,
            serviceId, serviceName, customerName, phone,
            date: new Date(date), timeSlot, status: 'pending',
            amount: amount || 0, notes: notes || ''
        });

        // Emit BOOKING_REQUEST signal
        const swarm = require('./swarm/SwarmManager').getSwarmManager(io);
        await swarm.postSignal('BOOKING_REQUEST', {
            appointmentId: apt.appointmentId,
            serviceName,
            customerName,
            phone,
            date,
            timeSlot
        }, workspaceId, { source: 'bookings' });

        io.to(workspaceId).emit('appointment_updated', apt);
        res.json({ success: true, appointment: apt });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/appointments/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Appointment.findOneAndUpdate(
            { workspaceId, appointmentId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Appointment not found' });

        if (updated.status === 'confirmed') {
            const swarm = require('./swarm/SwarmManager').getSwarmManager(io);
            await swarm.postSignal('BOOKING_CONFIRMED', {
                appointmentId: updated.appointmentId,
                serviceName: updated.serviceName,
                customerName: updated.customerName,
                phone: updated.phone,
                date: updated.date,
                timeSlot: updated.timeSlot
            }, workspaceId, { source: 'bookings' });
        }

        io.to(workspaceId).emit('appointment_updated', updated);
        res.json({ success: true, appointment: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pipeline API ─────────────────────────────────────────────────
const PipelineLead = require('./models/PipelineLead');

app.get('/api/pipelines', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { stage } = req.query;
        const filter = { workspaceId, status: 'active' };
        if (stage) filter.stage = stage;
        const leads = await PipelineLead.find(filter).sort({ createdAt: -1 });
        res.json({ success: true, leads });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pipelines', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const leadId = 'PL-' + Date.now().toString(36).toUpperCase();
        const lead = await PipelineLead.create({ ...req.body, workspaceId, orgId, leadId });
        io.to(workspaceId).emit('pipeline_updated', lead);
        res.json({ success: true, lead });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/pipelines/:id/stage', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await PipelineLead.findOneAndUpdate(
            { workspaceId, leadId: req.params.id },
            { $set: { stage: req.body.stage, stageChangedAt: new Date() } },
            { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Lead not found' });
        io.to(workspaceId).emit('pipeline_updated', updated);
        res.json({ success: true, lead: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/pipelines/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        await PipelineLead.findOneAndDelete({ workspaceId, leadId: req.params.id });
        io.to(workspaceId).emit('pipeline_deleted', { leadId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Prospecting API ──────────────────────────────────────────────
const Prospect = require('./models/Prospect');
const { Community, CommunityMember } = require('./models/Community');

app.get('/api/prospects', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const prospects = await Prospect.find({ workspaceId }).sort({ score: -1 });
        res.json({ success: true, prospects });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prospects', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const prospectId = 'PRO-' + Date.now().toString(36).toUpperCase();
        const { name, phone, source, notes } = req.body;
        const prospect = await Prospect.create({
            workspaceId, orgId, prospectId, name, phone,
            source: source || 'Cold Outreach', notes: notes || ''
        });

        // Auto-create WhatsApp Lead
        if (phone) {
            await Lead.findOneAndUpdate(
                { workspaceId, phone },
                { workspaceId, phone, name, source: 'Prospecting', qualification: 'WARM' },
                { upsert: true, new: true }
            ).catch(() => {});
        }

        io.to(workspaceId).emit('prospect_updated', prospect);
        res.json({ success: true, prospect });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/prospects/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Prospect.findOneAndUpdate(
            { workspaceId, prospectId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Prospect not found' });
        io.to(workspaceId).emit('prospect_updated', updated);
        res.json({ success: true, prospect: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Communities API ─────────────────────────────────────────────
app.get('/api/communities', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const communities = await Community.find({ workspaceId }).sort({ name: 1 });
        res.json({ success: true, communities });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/communities', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const communityId = 'COM-' + Date.now().toString(36).toUpperCase();
        const comm = await Community.create({ ...req.body, workspaceId, orgId, communityId });
        io.to(workspaceId).emit('community_updated', comm);
        res.json({ success: true, community: comm });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/communities/:id/members', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { name, phone } = req.body;
        const memberId = 'MEM-' + Date.now().toString(36).toUpperCase();
        const member = await CommunityMember.create({
            communityId: req.params.id, workspaceId, memberId, name, phone
        });

        // Update community count
        const count = await CommunityMember.countDocuments({ communityId: req.params.id });
        await Community.findOneAndUpdate({ communityId: req.params.id }, { memberCount: count });

        // Auto-create WhatsApp Lead
        if (phone) {
            await Lead.findOneAndUpdate(
                { workspaceId, phone },
                { workspaceId, phone, name, source: 'Community' },
                { upsert: true, new: true }
            ).catch(() => {});
        }

        io.to(workspaceId).emit('community_member_added', { communityId: req.params.id, count });
        res.json({ success: true, member });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HR API ──────────────────────────────────────────────────────
const { Employee, Attendance, Leave } = require('./models/Employee');

app.get('/api/employees', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const employees = await Employee.find({ workspaceId });
        res.json({ success: true, employees });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees', authMiddleware, async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const employeeId = 'EMP-' + Date.now().toString(36).toUpperCase();
        const emp = await Employee.create({ ...req.body, workspaceId, orgId, employeeId });
        io.to(workspaceId).emit('employee_updated', emp);
        res.json({ success: true, employee: emp });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/employees/:id', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Employee.findOneAndUpdate(
            { workspaceId, employeeId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Employee not found' });
        io.to(workspaceId).emit('employee_updated', updated);
        res.json({ success: true, employee: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/attendance', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { date } = req.query;
        const filter = { workspaceId };
        if (date) filter.date = { $gte: new Date(date), $lt: new Date(new Date(date).getTime() + 86400000) };
        const records = await Attendance.find(filter);
        res.json({ success: true, records });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/clock-in', authMiddleware, async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const { employeeId, employeeName, date } = req.body;
        const existing = await Attendance.findOne({
            workspaceId, employeeId,
            date: { $gte: new Date(date), $lt: new Date(new Date(date).getTime() + 86400000) }
        });
        if (existing) return res.status(409).json({ error: 'Already clocked in today' });
        const record = await Attendance.create({
            workspaceId, orgId, employeeId,
            date: new Date(date), clockIn: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
            status: 'present'
        });
        res.json({ success: true, record });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance/clock-out', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { employeeId, date } = req.body;
        const record = await Attendance.findOneAndUpdate(
            { workspaceId, employeeId, date: { $gte: new Date(date), $lt: new Date(new Date(date).getTime() + 86400000) } },
            { $set: { clockOut: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) } },
            { new: true }
        );
        res.json({ success: true, record });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaves', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const leaves = await Leave.find({ workspaceId }).sort({ createdAt: -1 });
        res.json({ success: true, leaves });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leaves', authMiddleware, async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const leaveId = 'LV-' + Date.now().toString(36).toUpperCase();
        const leave = await Leave.create({ ...req.body, workspaceId, orgId, leaveId });
        res.json({ success: true, leave });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/leaves/:id', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Leave.findOneAndUpdate(
            { workspaceId, leaveId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Leave not found' });
        res.json({ success: true, leave: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settlements API ──────────────────────────────────────────────
const { Invoice, Transaction } = require('./models/Invoice');

app.get('/api/settlements/summary', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
        const [succeeded, pending] = await Promise.all([
            Transaction.aggregate([{ $match: { workspaceId, status: 'Succeeded', createdAt: { $gte: thirtyDaysAgo } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
            Transaction.aggregate([{ $match: { workspaceId, status: 'Pending' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
        ]);
        res.json({
            success: true,
            summary: {
                totalVolume: succeeded[0]?.total || 0,
                pendingClearance: pending[0]?.total || 0,
                currency: 'INR'
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settlements/transactions', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const transactions = await Transaction.find({ workspaceId }).sort({ createdAt: -1 }).limit(100);
        res.json({ success: true, transactions });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        if (!workspaceId) return res.status(401).json({ error: 'Unauthorized' });
        const invoices = await Invoice.find({ workspaceId }).sort({ createdAt: -1 });
        res.json({ success: true, invoices });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const invoiceId = 'INV-' + Date.now().toString(36).toUpperCase();
        const inv = await Invoice.create({ ...req.body, workspaceId, orgId, invoiceId });
        io.to(workspaceId).emit('invoice_updated', inv);
        res.json({ success: true, invoice: inv });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/invoices/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Invoice.findOneAndUpdate(
            { workspaceId, invoiceId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Invoice not found' });
        io.to(workspaceId).emit('invoice_updated', updated);
        res.json({ success: true, invoice: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Builder API ─────────────────────────────────────────────────
const { Page, Funnel } = require('./models/Page');

app.get('/api/builder/pages', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const pages = await Page.find({ workspaceId }).sort({ createdAt: -1 });
        res.json({ success: true, pages });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/builder/pages', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const pageId = 'PG-' + Date.now().toString(36).toUpperCase();
        const { name, slug } = req.body;
        const page = await Page.create({ ...req.body, workspaceId, orgId, pageId, slug: slug || name.toLowerCase().replace(/\s+/g, '-') + '-' + pageId });
        io.to(workspaceId).emit('page_updated', page);
        res.json({ success: true, page });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/builder/pages/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Page.findOneAndUpdate(
            { workspaceId, pageId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Page not found' });
        io.to(workspaceId).emit('page_updated', updated);
        res.json({ success: true, page: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/builder/pages/:id/publish', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Page.findOneAndUpdate(
            { workspaceId, pageId: req.params.id },
            { $set: { status: 'live' } }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Page not found' });
        io.to(workspaceId).emit('page_updated', updated);
        res.json({ success: true, page: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/builder/pages/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        await Page.findOneAndDelete({ workspaceId, pageId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Public page renderer (no auth required)
app.get('/p/:slug', async (req, res) => {
    try {
        const page = await Page.findOne({ slug: req.params.slug, status: 'live' });
        if (!page) return res.status(404).send('Page not found');

        // Increment visits
        await Page.findByIdAndUpdate(page._id, { $inc: { visits: 1 } });

        // Generate simple HTML from blocks
        let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${page.name}</title><style>`;
        html += `body{font-family:'Instrument Sans',sans-serif;background:#0a0a09;color:#f0ede6;margin:0;padding:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;}`;
        html += `.container{max-width:600px;padding:40px 20px;width:100%;}`;
        html += `</style></head><body><div class="container">`;

        for (const block of page.blocks.sort((a,b) => a.order - b.order)) {
            switch (block.type) {
                case 'heading': html += `<h1 style="font-size:2.5rem;font-weight:900;margin-bottom:0.5rem">${block.content?.text || ''}</h1>`; break;
                case 'subheading': html += `<p style="font-size:1.2rem;color:#908a7e;margin-bottom:1.5rem">${block.content?.text || ''}</p>`; break;
                case 'paragraph': html += `<p style="line-height:1.7;margin-bottom:1rem">${block.content?.text || ''}</p>`; break;
                case 'cta_button':
                    const url = block.content?.whatsapp ? `https://wa.me/${block.content.whatsapp.replace(/\D/g,'')}?text=${encodeURIComponent(block.content.whatsappText || '')}` : block.content?.url || '#';
                    html += `<a href="${url}" style="display:inline-block;background:#E85D04;color:#fff;padding:14px 28px;border-radius:12px;font-weight:700;text-decoration:none;margin:8px 0">${block.content?.label || 'Get Started'}</a>`;
                    break;
                case 'divider': html += `<hr style="border-color:#333;margin:24px 0">`; break;
            }
        }

        html += `</div></body></html>`;
        res.type('html').send(html);
    } catch (err) { res.status(500).send('Server error'); }
});

// Public lead capture (no auth required)
app.post('/p/:slug/lead', async (req, res) => {
    try {
        const page = await Page.findOne({ slug: req.params.slug });
        if (!page) return res.status(404).json({ error: 'Page not found' });
        const { name, phone } = req.body;
        if (!phone) return res.status(400).json({ error: 'Phone required' });

        // Find the workspace by page's workspaceId
        const Session = require('./models/Session');
        const session = await Session.findOne({ clientId: page.workspaceId });
        if (!session) return res.status(404).json({ error: 'Workspace not found' });

        await Lead.findOneAndUpdate(
            { clientId: page.workspaceId, phone },
            { clientId: page.workspaceId, phone, name, source: 'Builder:' + page.name, qualification: 'WARM' },
            { upsert: true, new: true }
        );

        await Page.findByIdAndUpdate(page._id, { $inc: { conversions: 1 } });
        res.json({ success: true, message: 'Lead captured!' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Courses API ─────────────────────────────────────────────────
const { Course, Enrollment } = require('./models/Course');

app.get('/api/courses', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const courses = await Course.find({ workspaceId }).sort({ createdAt: -1 });
        res.json({ success: true, courses });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/courses', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const courseId = 'CRS-' + Date.now().toString(36).toUpperCase();
        const course = await Course.create({ ...req.body, workspaceId, orgId, courseId });
        io.to(workspaceId).emit('course_updated', course);
        res.json({ success: true, course });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/courses/:id', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const updated = await Course.findOneAndUpdate(
            { workspaceId, courseId: req.params.id },
            { $set: req.body }, { new: true }
        );
        if (!updated) return res.status(404).json({ error: 'Course not found' });
        io.to(workspaceId).emit('course_updated', updated);
        res.json({ success: true, course: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/courses/:id/enroll', async (req, res) => {
    try {
        const { orgId } = req;
        const workspaceId = req.workspaceId || req.userId;
        const { studentName, studentPhone } = req.body;
        const courseId = req.params.id;
        const enrollmentId = 'ENR-' + Date.now().toString(36).toUpperCase();

        const existing = await Enrollment.findOne({ workspaceId, courseId, studentPhone });
        if (existing) return res.status(409).json({ error: 'Already enrolled' });

        const enrollment = await Enrollment.create({
            workspaceId, orgId, enrollmentId, courseId,
            studentName: studentName || '', studentPhone: studentPhone || ''
        });

        await Course.findOneAndUpdate({ workspaceId, courseId }, { $inc: { enrolledCount: 1 } });
        res.json({ success: true, enrollment });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/courses/stats', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const [totalCourses, totalEnrollments] = await Promise.all([
            Course.countDocuments({ workspaceId }),
            Enrollment.countDocuments({ workspaceId })
        ]);
        res.json({ success: true, stats: { totalCourses, totalEnrollments } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ad Manager API ──────────────────────────────────────────────
const { AdAccount, Campaign } = require('./models/AdAccount');

app.get('/api/ads/status', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const accounts = await AdAccount.find({ workspaceId });
        const campaigns = await Campaign.find({ workspaceId });
        res.json({ success: true, accounts, campaigns });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ads/campaigns', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const { platform } = req.query;
        const filter = { workspaceId };
        if (platform && platform !== 'all') filter.platform = platform;
        const campaigns = await Campaign.find(filter).sort({ spend: -1 });
        res.json({ success: true, campaigns });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ads/stats', async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const campaigns = await Campaign.find({ workspaceId });
        const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
        const totalLeads = campaigns.reduce((s, c) => s + (c.leads || 0), 0);
        res.json({ success: true, stats: { totalSpend, totalLeads, avgCPL: totalLeads > 0 ? totalSpend / totalLeads : 0 } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ads/connect/:platform', async (req, res) => {
    // OAuth initiation — return the redirect URL
    const base = process.env.FRONTEND_URL || 'https://app.brandproinc.in';
    if (req.params.platform === 'meta') {
        const redirectUri = `${process.env.BACKEND_URL || 'https://engine.brandproinc.in'}/api/ads/callback/meta`;
        const url = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read,ads_management,business_management`;
        return res.json({ success: true, redirectUrl: url });
    }
    res.status(400).json({ error: 'Unknown platform' });
});

// ── Settings API ────────────────────────────────────────────────
const { NotificationPref, SecuritySetting } = require('./models/NotificationPref');

app.get('/api/settings/notifications', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        if (!workspaceId) return res.status(401).json({ error: 'Unauthorized' });
        let pref = await NotificationPref.findOne({ workspaceId });
        if (!pref) { pref = await NotificationPref.create({ workspaceId }); }
        res.json({ success: true, preferences: pref });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings/notifications', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        if (!workspaceId) return res.status(401).json({ error: 'Unauthorized' });
        const updated = await NotificationPref.findOneAndUpdate(
            { workspaceId },
            { $set: req.body },
            { upsert: true, new: true }
        );
        res.json({ success: true, preferences: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/settings/security', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        if (!workspaceId) return res.status(401).json({ error: 'Unauthorized' });
        let settings = await SecuritySetting.findOne({ workspaceId });
        if (!settings) { settings = await SecuritySetting.create({ workspaceId }); }
        res.json({ success: true, settings });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings/security', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        if (!workspaceId) return res.status(401).json({ error: 'Unauthorized' });
        const updated = await SecuritySetting.findOneAndUpdate(
            { workspaceId },
            { $set: req.body },
            { upsert: true, new: true }
        );
        res.json({ success: true, settings: updated });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin JWT middleware (stub — enforces OrgAdmin role) ──────────
function requireAdmin(req, res, next) {
    if (!req.org || !(req.org.role === 'owner' || req.org.isSuperAdmin)) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// Logs API
app.get('/api/logs', authMiddleware, async (req, res) => {
    res.json({ success: true, logs: systemLogs });
});

// Analytics API
app.get('/api/analytics', authMiddleware, async (req, res) => {
    try {
        const workspaceId = req.workspaceId || req.userId;
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const [openTickets, activeLeads, aiHandledLeads, dailyVolume] = await Promise.all([
            Ticket.countDocuments({ workspaceId, status: { $ne: 'resolved' } }),
            Lead.countDocuments({ workspaceId }),
            Lead.countDocuments({
                workspaceId,
                'conversation.role': 'ai'
            }),
            Lead.aggregate([
                { $match: { workspaceId, createdAt: { $gte: sevenDaysAgo } } },
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

// ── Admin: User Management ──────────────────────────────────────

// Super-admin guard: require x-client-id: 'admin' header
function requireSuperAdmin(req, res, next) {
    if (req.headers['x-client-id'] !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: super admin access required' });
    }
    next();
}

// GET /api/admin/users — list all users with org & role
app.get('/api/admin/users', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { search, role, orgId } = req.query;

        const filter = { isActive: true };
        if (search) {
            filter.$or = [
                { email: { $regex: search, $options: 'i' } },
                { displayName: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
            ];
        }

        const users = await User.find(filter).sort({ createdAt: -1 }).lean();

        // Fetch orgmembers & orgs in one shot
        const userIds = users.map(u => u.clientId);
        const members = await OrgMember.find({ userId: { $in: userIds } }).lean();
        const memberMap = {};
        for (const m of members) {
            if (!memberMap[m.userId]) memberMap[m.userId] = [];
            memberMap[m.userId].push(m);
        }

        const orgIds = [...new Set(members.map(m => m.orgId))];
        const orgs = await Organisation.find({ orgId: { $in: orgIds } }).lean();
        const orgMap = {};
        for (const o of orgs) orgMap[o.orgId] = o;

        const result = users.map(u => {
            const orgMembers = memberMap[u.clientId] || [];
            const primaryMember = orgMembers.find(m => m.orgId === u.primaryOrgId) || orgMembers[0];
            const org = primaryMember ? orgMap[primaryMember.orgId] : null;
            return {
                userId: u.clientId,
                email: u.email,
                displayName: u.displayName,
                phone: u.phone,
                role: primaryMember?.role || 'member',
                orgId: primaryMember?.orgId || null,
                orgName: org?.name || '—',
                lastLogin: u.lastLogin,
                createdAt: u.createdAt,
            };
        }).filter(u => {
            if (role && u.role !== role) return false;
            if (orgId && u.orgId !== orgId) return false;
            return true;
        });

        res.json({ success: true, users: result, total: result.length });
    } catch (err) {
        console.error('Admin list users error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/orgs — list all orgs (for dropdown)
app.get('/api/admin/orgs', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const orgs = await Organisation.find({}).sort({ createdAt: -1 }).lean();
        res.json({ success: true, orgs: orgs.map(o => ({ orgId: o.orgId, name: o.name, plan: o.plan })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/users — create a new user
app.post('/api/admin/users', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { email, password, displayName, phone, orgId, role } = req.body;

        if (!email || !password || !orgId) {
            return res.status(400).json({ error: 'Email, password, and org are required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        if (!['admin', 'member'].includes(role)) {
            return res.status(400).json({ error: 'Role must be admin or member' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const existing = await User.findOne({ email: normalizedEmail, isActive: true });
        if (existing) return res.status(409).json({ error: 'Email already in use' });

        const org = await Organisation.findOne({ orgId });
        if (!org) return res.status(404).json({ error: 'Organisation not found' });

        const userId = `usr_${crypto.randomUUID()}`;
        const hashedPassword = await bcrypt.hash(password, 12);
        const workspaceId = `ws_${crypto.randomUUID()}`;

        // Create user
        const user = new User({
            clientId: userId,
            email: normalizedEmail,
            password: hashedPassword,
            displayName: displayName || email.split('@')[0],
            phone: phone || '',
            authMethods: ['password'],
            primaryOrgId: orgId,
        });
        await user.save();

        // Create orgmember
        const member = new OrgMember({ userId, orgId, role });
        await member.save();

        // Create workspace
        const ws = new Workspace({
            workspaceId,
            orgId,
            name: displayName || email.split('@')[0],
        });
        await ws.save();

        // Create session
        await new Session({
            clientId: userId,
            orgId,
            workspaceId,
            email: normalizedEmail,
            displayName: displayName || email.split('@')[0],
            businessName: org.name,
            phone: phone || '',
        }).save();

        res.status(201).json({ success: true, userId, email: user.email });
    } catch (err) {
        console.error('Admin create user error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/users/:userId — update user
app.put('/api/admin/users/:userId', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { displayName, email, phone, role } = req.body;

        const user = await User.findOne({ clientId: userId });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const updates = {};
        if (displayName !== undefined) updates.displayName = displayName;
        if (phone !== undefined) updates.phone = phone;

        if (email !== undefined) {
            const normalizedEmail = email.toLowerCase().trim();
            const existing = await User.findOne({ email: normalizedEmail, isActive: true });
            if (existing && existing.clientId !== userId) {
                return res.status(409).json({ error: 'Email already in use' });
            }
            updates.email = normalizedEmail;
        }

        if (Object.keys(updates).length > 0) {
            await User.findOneAndUpdate({ clientId: userId }, { $set: updates });
        }

        if (role && ['admin', 'member'].includes(role)) {
            // Update orgmember role for the user's primary org
            const orgId = user.primaryOrgId;
            if (orgId) {
                await OrgMember.findOneAndUpdate({ userId, orgId }, { $set: { role } });
            }
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Admin update user error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/users/:userId — hard delete user
app.delete('/api/admin/users/:userId', authMiddleware, requireSuperAdmin, async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await User.findOne({ clientId: userId });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Hard delete: remove user, orgmembers, session, workspace, signals
        await User.deleteOne({ clientId: userId });
        await OrgMember.deleteMany({ userId });
        await Session.deleteMany({ clientId: userId });
        await Workspace.deleteMany({ orgId: user.primaryOrgId });
        await Organisation.deleteOne({ orgId: user.primaryOrgId });
        await Signal.deleteMany({ clientId: userId });

        res.json({ success: true, message: `User ${user.email} permanently deleted` });
    } catch (err) {
        console.error('Admin delete user error:', err);
        res.status(500).json({ error: err.message });
    }
});



app.post('/api/chats/:id/pause', async (req, res) => {
    const workspaceId = req.workspaceId || req.userId;
    const { id } = req.params;
    const isPaused = req.body.paused;
    await Lead.findOneAndUpdate(
        { workspaceId, phone: id.replace('@c.us', '') },
        { isAiPaused: isPaused },
        { upsert: true }
    );
    res.json({ success: true, paused: isPaused });
});
app.get('/api/chats/:id/pause', async (req, res) => {
    const workspaceId = req.workspaceId || req.userId;
    const { id } = req.params;
    const isPaused = await getChatState(workspaceId, id);
    res.json({ paused: isPaused });
});


// ── Unified Inbox & Gmail Integration ───────────────────────────

app.get('/api/inbox', async (req, res) => {
    try {
        const userId = req.userId;

        // Resolve ws_ session (actual WhatsApp engine) from usr_ session
        // Match by phone OR whatsappWid (JID like "918178081629@c.us")
        const session = await Session.findOne({ clientId: userId }).lean();
        const phone = session?.phone;
        const whatsappWid = session?.whatsappWid;
        let waClientId = userId;
        if (phone || whatsappWid) {
            const waSession = await Session.findOne({
                clientId: { $regex: /^ws_/ },
                whatsappConnected: true,
                $or: [
                    phone ? { phone } : null,
                    whatsappWid ? { whatsappWid: { $regex: whatsappWid.replace('@c.us', '') } } : null
                ].filter(Boolean)
            }).lean();
            if (waSession) waClientId = waSession.clientId;
        }

        // 1. Fetch WhatsApp chats — primary (Chat model) + fallback (Signal aggregation)
        const waPromise = (async () => {
            try {
                if (mongoose.connection.readyState !== 1) return [];

                // Try Chat model first (new messages from v2 onwards)
                // Filter out: broadcasts (@broadcast) and channels (@lid). Groups (@g.us) ARE included.
                // Sort: pinned first → unread high → most recently active
                const dbChats = await Chat.find({
                    clientId: waClientId,
                    isActive: true,
                    $nor: [
                        { wid: /@broadcast$/ },
                        { wid: /@lid$/ }
                    ]
                })
                    .sort({ pinned: -1, unread: -1, lastOpened: -1, lastInteraction: -1 })
                    .limit(500)
                    .lean();

                if (dbChats.length > 0) {
                    // Get contact names from Leads for better display
                    const phones = dbChats.map(c => c.wid.replace('@c.us', '').replace('@g.us', '')).filter(Boolean);
                    const leads = await Lead.find({ clientId: waClientId, phone: { $in: phones } }).lean();
                    const leadMap = Object.fromEntries(leads.map(l => [l.phone, l]));

                    return dbChats.map(c => {
                        const phone = c.wid.replace('@c.us', '').replace('@g.us', '');
                        const lead = leadMap[phone];
                        const displayName = lead?.name || c.name || (phone ? `+${phone}` : c.wid);
                        return {
                            id: c.wid,
                            type: 'whatsapp',
                            name: displayName,
                            phone: phone || null,
                            lastMessage: c.lastMessage || "Tap to chat",
                            fromMe: !!c.lastMessageFromMe,
                            lastInteraction: (c.lastInteraction || 0) * 1000,
                            lastOpened: (c.lastOpened || 0) * 1000,
                            unread: c.unread > 0,
                            pinned: !!c.pinned
                        };
                    });
                }

                // Fallback: build inbox from Signal records (historical messages before Chat model)
                // Exclude WhatsApp system notifications (no real conversation content). Groups are included.
                const signalChats = await Signal.aggregate([
                    {
                        $match: {
                            clientId: waClientId,
                            type: { $in: ['INBOUND_MESSAGE', 'OUTBOUND_MESSAGE'] },
                            'payload.mediaType': { $nin: ['notification_template', 'e2e_notification', 'unknown'] },
                            'payload.from': { $not: /@broadcast$/ },
                            'payload.from': { $not: /@lid$/ }
                        }
                    },
                    {
                        $addFields: {
                            bodyLen: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$payload.body', ''] } }, 0] }, 1, 0] }
                        }
                    },
                    { $sort: { bodyLen: -1, createdAt: -1 } },
                    {
                        $group: {
                            _id: '$payload.from',
                            lastMessage: {
                                $first: {
                                    $cond: [
                                        { $gt: [{ $strLenCP: { $ifNull: ['$payload.body', ''] } }, 0] },
                                        '$payload.body',
                                        { $concat: ['📎 ', { $ifNull: ['$payload.mediaType', 'Media'] }] }
                                    ]
                                }
                            },
                            lastInteraction: { $first: { $toLong: '$createdAt' } },
                            totalMessages: { $sum: 1 },
                            hasUnread: { $max: { $eq: ['$status', 'PENDING'] } }
                        }
                    },
                    { $sort: { lastInteraction: -1 } },
                    { $limit: 50 }
                ]);

                // Get lead names for Signal fallback too
                const signalPhones = signalChats.map(c => c._id.replace('@c.us', '').replace('@g.us', '')).filter(Boolean);
                const signalLeads = await Lead.find({ clientId: waClientId, phone: { $in: signalPhones } }).lean();
                const signalLeadMap = Object.fromEntries(signalLeads.map(l => [l.phone, l]));

                return signalChats.map(c => {
                    const phone = c._id.replace('@c.us', '').replace('@g.us', '');
                    const lead = signalLeadMap[phone];
                    const displayName = lead?.name || (phone ? `+${phone}` : c._id);
                    return {
                        id: c._id,
                        type: 'whatsapp',
                        name: displayName,
                        phone: phone || null,
                        lastMessage: c.lastMessage || "Tap to chat",
                        lastInteraction: c.lastInteraction * 1000,
                        unread: c.hasUnread
                    };
                });
            } catch (e) {
                console.log(`[Inbox] WhatsApp error for userId=${userId}: ${e.message}`);
                return [];
            }
        })();

        // 2. Fetch Gmail (Parallel)
        const gmailPromise = getGmailThreads(userId);

        const [waChats, emailThreads] = await Promise.all([waPromise, gmailPromise]);

        const inbox = [...waChats, ...emailThreads].sort((a, b) => b.lastInteraction - a.lastInteraction);
        res.json({ success: true, inbox });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/inbox/whatsapp/:id/messages ────────────────────────────────────────
// Returns messages with pagination. Pass ?before=<msgId>&limit=30
// Media is NOT downloaded eagerly — use /api/chats/:id/messages/:msgId/media for the actual file
app.get('/api/inbox/:type/:id/messages', async (req, res) => {
    try {
        const userId = req.userId;
        const { type, id } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 30, 80);
        const beforeMsgId = req.query.before || null;

        if (type === 'whatsapp') {
            const client = req.whatsapp || await getClient(userId);
            if (!client) return res.status(503).json({ error: "WhatsApp not connected" });

            try {
                const chat = await client.getChatById(id);

                // Build fetch options — use `before` cursor if provided
                const fetchOpts = { limit };
                if (beforeMsgId) {
                    // Find the message by ID to get its timestamp as cursor
                    const allForCursor = await chat.fetchMessages({ limit: 200 });
                    const cursorMsg = allForCursor.find(m => m.id._serialized === beforeMsgId);
                    if (cursorMsg) {
                        fetchOpts['before'] = cursorMsg;
                    }
                }

                const messages = await chat.fetchMessages(fetchOpts);

                // Track "last opened" so inbox sort matches WhatsApp Web behavior
                // (most recently opened chats bubble up, regardless of last message time)
                await Chat.updateOne(
                    { clientId: userId, wid: id },
                    { $set: { lastOpened: Math.floor(Date.now() / 1000) } }
                ).catch(() => {});

                const formatted = messages.map(m => {
                    let quotedObj = null;
                    if (m._data?.quotedMsg) {
                        const qm = m._data.quotedMsg;
                        quotedObj = {
                            id: qm.id?._serialized || qm.id,
                            body: (qm.body || '').substring(0, 200),
                            fromMe: qm.fromMe,
                            author: qm.author || (qm.fromMe ? id : null),
                            hasMedia: qm.hasMedia || false,
                            type: qm.type || 'chat'
                        };
                    }

                    // Check if edit is still possible (within ~15 min window)
                    const nowSecs = Math.floor(Date.now() / 1000);
                    const EDIT_WINDOW_SECS = 15 * 60;
                    const canEdit = m.fromMe && (nowSecs - m.timestamp) < EDIT_WINDOW_SECS;

                    return {
                        id: m.id._serialized,
                        fromMe: m.fromMe,
                        body: m.body,
                        timestamp: m.timestamp,
                        type: m.type || 'chat',
                        role: m.fromMe ? 'human' : 'lead',
                        ack: m.ack ?? (m.fromMe ? 1 : 0),
                        hasMedia: m.hasMedia,
                        // Only expose metadata — actual download via separate endpoint
                        mediaMimeType: m._data?.mediaData?.mimetype || null,
                        mediaSize: m._data?.mediaData?.filesize || null,
                        quotedMsg: quotedObj,
                        isStarred: !!(m._data?.star),
                        isEdited: !!(m._data?.editHistory?.length),
                        editCount: (m._data?.editHistory?.length) || 0,
                        canEdit
                    };
                });

                return res.json({
                    messages: formatted,
                    hasMore: messages.length === limit,
                    oldestId: messages.length > 0 ? messages[0].id._serialized : null
                });
            } catch (chatErr) {
                console.log(`[Inbox/Messages] getChatById failed: ${chatErr.message}. Falling back to Signal records.`);
                const signals = await Signal.find({
                    clientId: userId,
                    type: { $in: ['INBOUND_MESSAGE', 'OUTBOUND_MESSAGE'] },
                    'payload.from': id
                }).sort({ createdAt: -1 }).limit(limit).lean();
                return res.json({
                    messages: signals.map(s => ({
                        id: s.sourceId || s._id.toString(),
                        fromMe: s.type === 'OUTBOUND_MESSAGE',
                        body: s.payload?.body || '',
                        timestamp: s.payload?.timestamp || Math.floor(s.createdAt.getTime() / 1000),
                        role: s.type === 'OUTBOUND_MESSAGE' ? 'human' : 'lead',
                        ack: s.type === 'OUTBOUND_MESSAGE' ? (s.status === 'PENDING' ? 1 : 3) : 0,
                        type: 'chat',
                        hasMedia: false,
                        canEdit: false,
                        isStarred: false,
                        isEdited: false
                    })),
                    hasMore: signals.length === limit
                });
            }
        } else if (type === 'email') {
            const messages = await getGmailThreadMessages(userId, id);
            return res.json({ messages, hasMore: false });
        }

        res.status(400).json({ error: 'Invalid inbox type' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/chats/:id/messages/:msgId/media ──────────────────────────────────
// Lazy download of a single message's media (avoids downloading all media eagerly)
app.get('/api/chats/:id/messages/:msgId/media', async (req, res) => {
    const client = req.whatsapp || await getClient(req.userId);
    if (!client) return res.status(503).json({ error: "WhatsApp not connected" });
    try {
        const chat = await client.getChatById(req.params.id);
        const allMsgs = await chat.fetchMessages({ limit: 200 });
        const msg = allMsgs.find(m => m.id._serialized === req.params.msgId);
        if (!msg) return res.status(404).json({ error: "Message not found" });
        if (!msg.hasMedia) return res.status(404).json({ error: "No media in this message" });

        const media = await msg.downloadMedia();
        if (!media) return res.status(404).json({ error: "Failed to download media" });

        const b64 = media.data;
        const buf = Buffer.from(b64, 'base64');
        res.set('Content-Type', media.mimetype);
        res.set('Content-Disposition', `inline; filename="media.${media.mimetype.split('/')[1]}"`);
        res.set('Content-Length', buf.length);
        res.send(buf);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/sync', async (req, res) => {
    try {
        const userId = req.userId;

        // Resolve ws_ session for WhatsApp operations
        const session = await Session.findOne({ clientId: userId }).lean();
        const phone = session?.phone;
        let waClientId = userId;
        if (phone) {
            const waSession = await Session.findOne({
                clientId: { $regex: /^ws_/ },
                $or: [
                    { phone: phone },
                    { whatsappWid: { $regex: phone + '@' } }
                ],
                whatsappConnected: true
            }).lean();
            if (waSession) waClientId = waSession.clientId;
        }

        const client = await getClient(waClientId);
        if (!client) {
            return res.status(404).json({ error: "WhatsApp client not found. Please reconnect." });
        }
        try {
            const chats = await client.getChats();
            // Seed Chat model from WhatsApp (for historical chats)
            await Promise.all(chats.map(c => {
                const wid = c.id?._serialized || c.id;
                return upsertChat(waClientId, wid, c.name, c.lastMessage?.body, c.timestamp, false, !!c.pinned);
            }));
            res.json({ success: true, count: chats.length });
        } catch (getChatsErr) {
            // Puppeteer fallback: return count from Chat model
            const count = await Chat.countDocuments({ clientId: waClientId, isActive: true });
            console.log(`[Chats Sync] getChats() failed: ${getChatsErr.message}. Returning ${count} from DB.`);
            res.json({ success: true, count, source: 'db' });
        }
    } catch (err) {
        console.error(`[Chats Sync] Error for userId=${req.userId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    let cid = socket.handshake.query.clientId;
    // Fall back to JWT workspaceId if query param is empty
    if (!cid || cid === 'undefined') {
        const cookieHeader = socket.handshake.headers?.cookie || '';
        const match = cookieHeader.match(/(?:^|;\s*)concertos_token=([^;]+)/);
        const token = match ? decodeURIComponent(match[1]) : null;
        if (token) {
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                cid = decoded.workspaceId || cid;
            } catch (_) {}
        }
    }
    console.log(`🔌 Dashboard Socket Connected [ID: ${socket.id}, Client: ${cid || 'N/A'}]`);

    if (cid && cid !== 'undefined') {
        socket.join(cid);
        getClient(cid).catch(() => {}); // Proactively warm up session
    }

    socket.on('join', async (clientId) => {
        // Fall back to workspaceId from JWT cookie if clientId is empty
        // (can happen when dashboard connects before workspace context loads)
        if (!clientId) {
            const cookieHeader = socket.handshake.headers?.cookie || '';
            const match = cookieHeader.match(/(?:^|;\s*)concertos_token=([^;]+)/);
            const token = match ? decodeURIComponent(match[1]) : null;
            if (token) {
                try {
                    const jwt = require('jsonwebtoken');
                    const decoded = jwt.verify(token, process.env.JWT_SECRET);
                    clientId = decoded.workspaceId || null;
                } catch (_) {}
            }
        }
        if (!clientId) return;
        socket.join(clientId);
        console.log(`👤 Client joined room: ${clientId}`);

        // Find the best session to report WhatsApp status from.
        // Priority: ws_ (actual WhatsApp engine) > usr_ (user identity session)
        let waClientId = clientId;
        const userSession = await Session.findOne({ clientId });
        if (userSession) {
            const phone = userSession.phone;
            const whatsappWid = userSession.whatsappWid;
            if (phone || whatsappWid) {
                const waSession = await Session.findOne({
                    clientId: { $regex: /^ws_/ },
                    whatsappConnected: true,
                    $or: [
                        phone ? { phone } : null,
                        whatsappWid ? { whatsappWid: { $regex: whatsappWid.replace('@c.us', '') } } : null
                    ].filter(Boolean)
                }).lean();
                if (waSession) waClientId = waSession.clientId;
            }
        }

        // Only warm up WhatsApp for the ws_ client (not usr_'s separate WhatsApp instance)
        // This prevents usr_ from trying to auth its own WhatsApp and generating stale QR codes
        if (waClientId !== clientId || clientId.startsWith('ws_')) {
            getClient(waClientId).catch(() => {});
        }

        const waSession = await Session.findOne({ clientId: waClientId });
        console.log(`[JOIN] clientId=${clientId} waClientId=${waClientId} waSession.status=${waSession?.status} waSession.qr=${waSession?.qr ? 'HAS_QR' : 'null'} waSession.wid=${waSession?.whatsappWid}`);
        if (waSession?.qr) {
            socket.emit('qr', waSession.qr);
        } else if (waSession?.status === 'READY') {
            socket.emit('ready', 'Connected');
        } else {
            socket.emit('status', waSession?.status || 'DISCONNECTED');
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

