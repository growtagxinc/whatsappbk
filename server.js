require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
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
// Always uses Baileys WebSocket mode (QR code, anti-ban protocol, no Chromium)
// Puppeteer/whatsapp-web.js has been removed.
const USE_BAILEYS = true;

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

let processMessage, determineIntent, handleVision, getConfig, updateConfig;
try {
    ({ processMessage, determineIntent } = require('./ai/ai-router'));
} catch (e) {
    console.warn('⚠️ AI router unavailable:', e.code);
    processMessage = determineIntent = async () => ({ type: 'unknown', confidence: 0 });
}
try {
    ({ handleVision } = require('./ai/vision'));
} catch (e) {
    handleVision = async () => null;
}
try {
    ({ getConfig, updateConfig } = require('./ai/agents'));
} catch (e) {
    getConfig = updateConfig = async () => null;
}
let auditProfile;
try {
    auditProfile = require('./ai/audit').auditProfile;
} catch (e) {
    auditProfile = async () => ({ success: false, data: null });
}
let safeJsonParse;
try {
    ({ safeJsonParse } = require('./ai/utils'));
} catch (e) {
    safeJsonParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
}

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

        // Baileys live status as primary, DB flag as fallback
        const baileysStatus = baileysManager.getStatus(userId);
        res.json({
            session,
            baileysStatus,
            whatsappConnected: baileysStatus.connected || session.whatsappConnected || false,
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

        // Guard: if already has a QR in DB AND auth files exist on disk, reuse it.
        // If the auth files were wiped (e.g. server restart), the stale QR will be
        // rejected by WhatsApp — clear it so a fresh one is generated.
        const clientDir = path.join(process.cwd(), 'sessions', clientId);
        const hasAuthFiles = fs.existsSync(clientDir);
        const existingSession = await Session.findOne({ clientId });
        if (existingSession?.qr && existingSession?.status === 'UNAUTHENTICATED' && hasAuthFiles) {
            console.log(`[Init] QR already exists for ${clientId}, reusing (auth files present)`);
            return res.json({ success: true, message: "QR already available" });
        }
        // QR is stale (no auth files) — clear it and regenerate
        if (existingSession?.qr) {
            await Session.updateOne({ clientId }, { $set: { qr: null, status: 'DISCONNECTED' } });
            console.log(`[Init] Cleared stale QR for ${clientId} (no auth files)`);
        }

        // Baileys WebSocket mode — QR code streamed via Socket.io
        await baileysManager.initializeSession(clientId).catch(err => console.error("[Baileys] Init Error:", err));
        res.json({ success: true, message: "Baileys initializing — scan QR from dashboard" });
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
        await baileysManager.destroySession(clientId);
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
// ── Baileys Integration (WebSocket mode, no Chromium/Puppeteer) ──────
let baileysManager = null;
console.log('[Baileys] Initializing WhatsApp WebSocket mode (Baileys).');
baileysManager = new WhatsAppManager(io, { queue: null });

// Wire Groq client to Baileys for AI message variability (anti-ban)
try {
    const { Groq } = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    baileysManager.setGroqClient(groq);
} catch (e) {
    console.warn('[Baileys] Groq client not available — message variability disabled.');
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

// Helper to initialize a Baileys session for a user
// Delegates to WhatsAppManager which handles all WebSocket/QR logic.
async function getClient(clientId) {
    if (!clientId) return null;
    return await baileysManager.wakeClient(clientId);
}

async function purgeClient(clientId) {
    if (!clientId) return;
    console.log(`🧹 FULL PURGE: ${clientId}`);
    try {
        // 1. Destroy Baileys session
        await baileysManager.destroySession(clientId);

        // 2. Nuke the Baileys auth session directory (clean slate for re-link)
        const sessionDir = path.join(process.cwd(), 'sessions', clientId);
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`🗑️ Session directory deleted: ${clientId}`);
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


// Puppeteer/whatsapp-web.js has been fully removed. WhatsAppManager handles all events.




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

    // Baileys session is lazily initialized by routes that need it — no pre-loading here.
    req.whatsapp = null;
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
            isLoaded: !!baileysManager.getStatus(clientId)?.socket,
            paperclip: false,
            baileys: USE_BAILEYS ? baileysManager?.getStatus(clientId) : null,
        });
    } catch (e) {
        res.json({ status: 'UP', whatsapp: 'DISCONNECTED(ERR)', hasActiveQR: false, userName: null, isLoaded: false, paperclip: false, baileys: USE_BAILEYS });
    }
});

app.get('/api/chats', async (req, res) => {
    try {
        const userId = req.userId;
        const baileysStatus = baileysManager.getStatus(userId);
        const chats = await Chat.find({ clientId: userId, isActive: true })
            .sort({ lastMessageAt: -1 }).limit(50).lean();
        res.json({
            chats: chats.map(c => ({
                id: c.wid,
                name: c.name || c.wid?.replace('@c.us', '').replace('@g.us', ''),
                unreadCount: 0,
                lastMessage: c.lastMessage || '',
                profilePic: null,
                pinned: !!c.isPinned
            })),
            whatsappStatus: baileysStatus.connected ? 'CONNECTED' : 'DISCONNECTED',
            phone: baileysStatus.phone || '',
            pushname: baileysStatus.pushname || ''
        });
    } catch (err) {
        res.json({ chats: [], whatsappStatus: 'DISCONNECTED', error: err.message });
    }
});
// Mark chat messages as read
app.post('/api/chats/:id/read', async (req, res) => {
    res.status(503).json({ error: "Mark as read not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
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
    try {
        const { text, quotedMsgId } = req.body;
        if (!text) return res.status(400).json({ error: "Message text required" });
        await baileysManager.sendSafeReply(req.clientId, req.params.id, text, quotedMsgId || null);
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

        // Baileys mode: add WebSocket session info
        profile.baileys = baileysManager.getStatus(userId);

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
    try {
        const { chatId, message, quotedMessageId } = req.body;
        await baileysManager.sendSafeReply(req.clientId, chatId, message, quotedMessageId || null);
        await upsertChat(req.clientId, chatId, '', message, Math.floor(Date.now() / 1000), true);
        res.json({ success: true, timestamp: Date.now() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/chats/:id/messages/:msgId — Delete for everyone
app.delete('/api/chats/:id/messages/:msgId', async (req, res) => {
    res.status(503).json({ error: "Delete message not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});

// PUT /api/chats/:id/messages/:msgId — Edit sent message (within ~15 min window)
app.put('/api/chats/:id/messages/:msgId', async (req, res) => {
    res.status(503).json({ error: "Edit message not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});

// POST /api/chats/:id/messages/:msgId/star — Star or unstar a message
app.post('/api/chats/:id/messages/:msgId/star', async (req, res) => {
    res.status(503).json({ error: "Star message not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});

// POST /api/chats/:id/messages/:msgId/react — React to a message with emoji
app.post('/api/chats/:id/messages/:msgId/react', async (req, res) => {
    res.status(503).json({ error: "React to message not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});

// POST /api/chats/:id/forward — Forward one or more messages to one or more chats
app.post('/api/chats/:id/forward', async (req, res) => {
    res.status(503).json({ error: "Forward message not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});

// PATCH /api/chats/:id — Update chat settings (archive, mute, pin, mark unread)
app.patch('/api/chats/:id', async (req, res) => {
    res.status(503).json({ error: "Chat settings not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});


app.post('/api/chats/:id/force-ai', async (req, res) => {
    res.status(503).json({ error: "Force AI not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
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
            const activeClients = baileysManager?.getStats()?.activeClients || 0;
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
            hasActiveClient: !!baileysManager.getStatus(s.clientId)?.socket,
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

        // Baileys: WhatsApp session is the user's session directly
        const session = await Session.findOne({ clientId: userId }).lean();
        const waClientId = userId;

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
            // Baileys mode: fetch messages from Signal records (message history)
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
        } else if (type === 'email') {
            const messages = await getGmailThreadMessages(userId, id);
            return res.json({ messages, hasMore: false });
        }

        res.status(400).json({ error: 'Invalid inbox type' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/chats/:id/messages/:msgId/media ──────────────────────────────────
app.get('/api/chats/:id/messages/:msgId/media', async (req, res) => {
    res.status(503).json({ error: "Media download not yet implemented in Baileys mode", code: 'NOT_IMPLEMENTED' });
});

app.post('/api/chats/sync', async (req, res) => {
    try {
        const userId = req.userId;
        // Baileys: sync chats from DB (WhatsAppManager seeds Chat model on message receipt)
        const count = await Chat.countDocuments({ clientId: userId, isActive: true });
        res.json({ success: true, count, source: 'db' });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

        // Warm up Baileys session for this user
        getClient(clientId).catch(() => {});

        const waSession = await Session.findOne({ clientId });
        const hasAuthFiles = fs.existsSync(path.join(process.cwd(), 'sessions', clientId));
        // Check if auth files contain valid Baileys credentials (creds.json exists = authenticated)
        const hasValidBaileysAuth = hasAuthFiles && fs.existsSync(path.join(process.cwd(), 'sessions', clientId, 'creds.json'));
        console.log(`[JOIN] clientId=${clientId} waSession.status=${waSession?.status} waSession.qr=${waSession?.qr ? 'HAS_QR' : 'null'} hasAuth=${hasAuthFiles} hasValidBaileysAuth=${hasValidBaileysAuth}`);

        // If user is fully authenticated with Baileys, emit ready
        if (hasValidBaileysAuth && waSession?.status === 'READY') {
            socket.emit('ready', 'Connected');
        } else if (hasAuthFiles && !hasValidBaileysAuth) {
            // Auth directory exists but no valid creds — needs fresh QR from Baileys
            socket.emit('status', 'DISCONNECTED');
        } else if (waSession?.status === 'READY') {
            socket.emit('ready', 'Connected');
        } else {
            // No auth files, no QR stored — Baileys will emit fresh QR via initializeSession
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

