'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const CircuitBreaker = require('opossum');
const Bottleneck = require('bottleneck');

// ─────────────────────────────────────────────────────────────────────────────
// WhatsAppManager — Baileys-based WhatsApp integration for ConcertOS
//
// Phase 1: Efficient Onboarding & Registration
// Phase 2: Stealth-Human Anti-Ban Protocol
// Phase 3: AWS 8GB RAM Optimization (Lazy Load Engine)
// ─────────────────────────────────────────────────────────────────────────────

// In-memory stores (RAM-bounded)
const clients = new Map();         // clientId -> Baileys socket
const sessions = new Map();        // clientId -> SessionState
const idleTimers = new Map();      // clientId -> Timeout
const pendingMessages = new Map(); // clientId -> Array of { jid, text, timestamp }
const lastActivity = new Map();    // clientId -> timestamp
const messageQueue = [];           // BullMQ queue fallback (Redis-backed in production)
const linkFailures = new Map();    // clientId -> consecutive failure count (for 405 backoff)

// Config constants
const SESSION_DIR = path.join(process.cwd(), 'sessions');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes
const MAX_OUTBOUND_PER_HOUR = 50;
const COOLDOWN_MS = 60 * 1000;            // 1 minute between queued sends
const PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LAZY_SYNC_CHAT_LIMIT = 10;

class WhatsAppManager {
    constructor(io, { redis, queue } = {}) {
        this.io = io;
        this.redis = redis;
        this.queue = queue;
        this.pruneTimer = null;
        this.groqClient = null;
        this.reconnectAttempts = new Map(); // Track reconnect attempts per client
        this.healthChecks = new Map(); // Track health check intervals
        this._onConnectedFired = new Map(); // Track per-client whether _onConnected has run for current socket
        this._healthCheckStopped = new Map(); // Track whether health check was stopped by close event

        // ── Circuit Breakers & Rate Limiters ────────────────────────────
        // Per-client rate limiters (prevents WhatsApp ban from burst sends)
        this.clientLimiters = new Map();

        // Global circuit breakers for WhatsApp operations
        this._circuitBreakers = new Map();

        // Ensure session directory exists
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }

        this._startPruner();
    }

    // ── Circuit Breaker Factory ────────────────────────────────────────
    // Returns or creates a circuit breaker for a given operation name.
    // Opens circuit on >50% failures in 10s window → 30s cooldown before half-open.
    _getBreaker(operationName, options = {}) {
        if (!this._circuitBreakers.has(operationName)) {
            const breaker = new CircuitBreaker(
                async (...args) => {
                    // Wrapper: extract the actual function and args
                    const [fn, ...fnArgs] = args;
                    return fn(...fnArgs);
                },
                {
                    timeout: options.timeout || 10000,      // Consider failed if >10s
                    errorThresholdPercentage: 50,           // Open if >50% failures
                    resetTimeout: 30000,                    // Try again after 30s
                    ...options,
                }
            );

            // Log circuit state changes
            breaker.on('open', () => {
                console.warn(`[CIRCUIT] ${operationName} OPEN — WhatsApp operations failing`);
            });
            breaker.on('close', () => {
                console.log(`[CIRCUIT] ${operationName} CLOSED — WhatsApp operations restored`);
            });
            breaker.on('halfOpen', () => {
                console.log(`[CIRCUIT] ${operationName} HALF-OPEN — testing recovery`);
            });

            this._circuitBreakers.set(operationName, breaker);
        }
        return this._circuitBreakers.get(operationName);
    }

    // ── Per-Client Rate Limiter Factory ────────────────────────────────
    // Returns or creates a Bottleneck rate limiter for a client.
    // Enforces max 50 msgs/hour via minTime spacing (3600s / 50 = 72s between sends).
    _getClientLimiter(clientId) {
        if (!this.clientLimiters.has(clientId)) {
            const limiter = new Bottleneck({
                maxConcurrent: 1,          // One send at a time
                minTime: 72000,            // 72s between sends = 50/hour max
            });
            this.clientLimiters.set(clientId, limiter);
        }
        return this.clientLimiters.get(clientId);
    }

    // ── Circuit-Protected Message Send ────────────────────────────────
    // Wraps _sendRaw in a circuit breaker — on open, queues message instead of failing.
    async _sendWithCircuit(clientId, jid, text, opts = {}) {
        const breaker = this._getBreaker('whatsapp:send');

        const sendFn = () => this._sendRaw(clientId, jid, text, opts);

        try {
            return await breaker.fire(sendFn);
        } catch (err) {
            // Circuit is open or operation failed — queue message for retry
            console.warn(`[CIRCUIT] Send blocked for ${clientId}, queueing: ${err.message}`);
            await this._queueMessage(clientId, jid, text, opts);
            return { queued: true, reason: 'circuit_open' };
        }
    }

    setGroqClient(client) {
        this.groqClient = client;
    }

    // ── Phase 1: Session Initialization ──────────────────────────────────────

    /**
     * Initialize (or resume) a Baileys session for a given client.
     * Emits QR code to the client's Socket.io room for onboarding.
     * @param {string} clientId
     * @returns {Promise<object>} Baileys socket
     */
    async initializeSession(clientId, phone) {
        if (!clientId) throw new Error('clientId required');

        // Derive a stable session key from phone — survives auth method changes (password vs Google OAuth).
        // Key is SHA-256 hash of the phone number, first 16 hex chars. Falls back to clientId when phone is unavailable.
        const phoneHash = phone
            ? crypto.createHash('sha256').update(phone).digest('hex').substring(0, 16)
            : null;
        const sessionKey = phoneHash || clientId;

        // Return existing authenticated socket (in-memory Map keyed by clientId — always use clientId here)
        if (clients.has(clientId)) {
            const sock = clients.get(clientId);
            if (sock.ws && sock.ws.readyState === 1) {
                console.log(`[Baileys] Reusing existing socket for ${clientId} (readyState=${sock.ws.readyState})`);
                return sock;
            }
            console.log(`[Baileys] Stale socket found for ${clientId} (readyState=${sock.ws?.readyState}), reinitializing`);
        }

        // Wipe stale session files on every fresh init attempt — this fixes the case where
        // WhatsApp rejected the link (405 "too many devices") and Baileys can't resume.
        // Without this, the stale creds cause immediate failure on reconnect, no QR ever generated.
        const clientDir = path.join(SESSION_DIR, sessionKey);
        if (fs.existsSync(clientDir)) {
            try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch (e) {}
            console.log(`[Baileys] Cleared stale session files for ${clientId}`);
        }
        if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });

        const seq = (this._initSeq = (this._initSeq || 0) + 1);
        console.log(`[Baileys] [SEQ=${seq}] INITIALIZING session for: ${clientId} (clients.size=${clients.size})`);
        this._resetIdleTimer(clientId);

        // Reset state for a fresh init — clear any lingering health check
        if (this.healthChecks.has(clientId)) {
            clearInterval(this.healthChecks.get(clientId));
            this.healthChecks.delete(clientId);
        }
        this._onConnectedFired.set(clientId, false);
        this.reconnectAttempts.set(clientId, 0);

        let { state, saveCreds } = await useMultiFileAuthState(clientDir);

        // If creds.json doesn't exist or has no valid identity, clear stale session dir.
        // This handles Puppeteer-era auth files that Baileys can't use.
        const credsPath = path.join(clientDir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
            try { fs.rmSync(clientDir, { recursive: true, force: true }); } catch (e) {}
            fs.mkdirSync(clientDir, { recursive: true });
            const fresh = await useMultiFileAuthState(clientDir);
            state = fresh.state;
            saveCreds = fresh.saveCreds;
        }

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'warn' })),
            },
            logger: pino({ level: 'warn' }),
            printQRInTerminal: false,
            defaultQueryTimeoutMs: 60_000,
            // Disable heavy features to save RAM
            getMessage: async () => undefined, // Lazy — don't fetch full message history
        });

        clients.set(clientId, sock);
        this._onConnectedFired.set(clientId, false);
        sessions.set(clientId, { socket: sock, initialized: false });
        sock._clientSeq = (this._sockSeq = (this._sockSeq || 0) + 1);
        console.log(`[Baileys] [SOCK=${sock._clientSeq}] Created socket for ${clientId}, clients.size=${clients.size}`);

        sock.ev.on('creds.update', saveCreds);

        // ── Patch end() so genPairQR() can emit QR before listeners are removed ──
        // Baileys' internal end() removes all ev listeners BEFORE genPairQR's setTimeout(0)
        // QR can fire. Fix: defer removeAllListeners by one tick so queued events fire first.
        // We patch sock.ev.removeAllListeners — in Baileys v6 this IS the internal ev.
        const origRemoveAllListeners = sock.ev.removeAllListeners.bind(sock.ev);
        sock.ev.removeAllListeners = function(...args) {
            // Defer removal so any queued connection.update { qr } events reach our handler first
            setTimeout(() => { origRemoveAllListeners(...args); }, 0);
        };

        // ── Phase 3: Wire incoming messages to Swarm/blackboard ──────────────
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (msg.key.fromMe) continue; // Skip outbound
                const result = await this.handleIncoming(clientId, msg);
                if (!result || !result.text) continue;

                // Route to Swarm blackboard
                try {
                    const { getSwarmManager } = require('../../swarm/SwarmManager');
                    const swarm = getSwarmManager(this.io);
                    await swarm.postSignal('INBOUND_MESSAGE', {
                        from: result.jid,
                        body: result.text,
                        hasMedia: result.hasMedia,
                        timestamp: result.key?.timestamp,
                        messageId: result.key?.id,
                    }, clientId, {
                        source: 'baileys',
                        sourceId: result.key?.id,
                    });

                    // Legacy fallback: direct AI processing if no agents configured
                    const AgentState = require('../../models/AgentState');
                    const agentCount = await AgentState.countDocuments({ clientId });
                    if (agentCount === 0 && result.text) {
                        const { processMessage } = require('../../ai/ai-router');
                        const aiReply = await processMessage(result.text, null);
                        if (aiReply && aiReply.response) {
                            await this.sendSafeReply(clientId, result.jid, aiReply.response);
                        }
                    }
                } catch (err) {
                    console.error(`[Baileys Swarm] Error routing message: ${err.message}`);
                }
            }
        });
        // ─────────────────────────────────────────────────────────────────────

        // QR is handled inside connection.update (qr field in v6)
        // ── Pairing Code (WhatsApp Web-style 8-digit code) ──────────────────
        sock.ev.on('CB:iq,,pair-success', async (stanza) => {
            console.log(`[Baileys] Pairing SUCCESS for ${clientId}`);
            this._emit(clientId, 'pairing_success', true);
            this._updateStatus(clientId, 'PAIRING_SUCCESS', { pairingCode: null });
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Log ALL connection.update events for debugging
            if (connection !== 'open' && connection !== 'close' && !qr) {
                console.log(`[Baileys] connection.update: conn=${connection} qr=${qr ? 'YES' : 'none'} update=${JSON.stringify(update)}`);
            }

            // Baileys v6 emits QR via connection.update as { qr } — but only if
            // the pairing handshake reaches genPairQR() before CB:failure kills the emitter.
            // When WhatsApp sends <failure>, end() removes all listeners before QR can fire.
            if (qr) {
                console.log(`[Baileys] QR RECEIVED for ${clientId}`);
                try {
                    const QR = require('qrcode');
                    const qrUrl = await QR.toDataURL(qr);
                    console.log(`[Baileys] QR encoded for ${clientId}, len=${qrUrl.length}`);
                    this._emit(clientId, 'qr', qrUrl);
                    this._updateStatus(clientId, 'UNAUTHENTICATED', { qr: qrUrl });
                } catch (e) {
                    console.error(`[Baileys] QR encoding failed for ${clientId}: ${e.message}`);
                }
                return;
            }

            if (connection === 'open') {
                const sockSeq = (sock._seq = (sock._seq || 0) + 1);
                console.log(`[Baileys] [SEQ=${sockSeq}] OPEN event for ${clientId} (wasConnected=${this._onConnectedFired.get(clientId)})`);
                if (this._onConnectedFired.get(clientId)) {
                    console.log(`[Baileys] [SEQ=${sockSeq}] OPEN skipped — _onConnected already ran for this client`);
                    return; // Guard: skip if _onConnected already ran
                }
                this._onConnectedFired.set(clientId, true);
                console.log(`[Baileys] [SEQ=${sockSeq}] Connected for ${clientId}, running _onConnected...`);
                this._updateStatus(clientId, 'READY', { authenticated: true, qr: null });
                this._emit(clientId, 'ready', 'Baileys Connected');
                sessions.get(clientId).initialized = true;
                await this._onConnected(clientId, sock);
                console.log(`[Baileys] [SEQ=${sockSeq}] _onConnected DONE for ${clientId}`);

                // Start health check for this client
                this._startHealthCheck(clientId);
            }

            if (connection === 'close') {
                const errMsg = lastDisconnect?.error?.message || '';
                const errTag = lastDisconnect?.error?.output?.statusCode;
                const wasIntentional = errTag === 500 && errMsg.includes('restart');
                const currentSock = clients.get(clientId);
                const isCurrent = currentSock === sock;
                const sockSeq = sock._clientSeq || '?';

                console.log(`[Baileys] [SOCK=${sockSeq}] CLOSE event for ${clientId}: intentional=${wasIntentional} tag=${errTag} msg="${errMsg}" | isCurrent=${isCurrent} | clients.size=${clients.size}`);

                // Only reset _onConnectedFired if this is the CURRENT active socket.
                // Old sockets from a previous init may fire close AFTER new socket connects.
                if (isCurrent) {
                    this._onConnectedFired.set(clientId, false);
                    console.log(`[Baileys] [SOCK=${sockSeq}] RESET _onConnectedFired (was current socket)`);
                } else {
                    console.log(`[Baileys] [SOCK=${sockSeq}] Did NOT reset _onConnectedFired (was OLD socket, current is ${currentSock?._clientSeq || 'none'})`);
                }

                console.log(`[Baileys] close event for ${clientId}: intentional=${wasIntentional} tag=${errTag} msg="${errMsg}"`);

                // ── Detect 405 link-rejected failure ──────────────────────────
                // WhatsApp returns 405 when:
                // - Account has too many linked devices (>5)
                // - Device was previously linked then unlinked (stale session)
                // - Rate limit hit on the link endpoint
                const is405 = errTag === 405 || errMsg.includes('link rejected') ||
                    errMsg.toLowerCase().includes('too many devices') ||
                    errMsg.toLowerCase().includes('unpaired');
                const isStale = errMsg.toLowerCase().includes('stale') || errMsg.toLowerCase().includes('pairing');

                if (is405 || isStale) {
                    const count = (linkFailures.get(clientId) || 0) + 1;
                    linkFailures.set(clientId, count);

                    console.warn(`[Baileys] Link failure #${count} for ${clientId}: ${errMsg}`);

                    if (count === 1) {
                        // First failure — emit guidance, no auto-retry
                        this._emit(clientId, 'link_error', {
                            code: is405 ? 'TOO_MANY_DEVICES' : 'STALE_SESSION',
                            message: is405
                                ? 'WhatsApp rejected the link — too many devices may be linked to your account. Unlink unused devices from your phone and try again.'
                                : 'Your WhatsApp session is stale. Unlink unused devices from your phone and try again.',
                            retryIn: null,
                            hint: 'On WhatsApp: Settings → Linked Devices → Unlink devices you don\'t use',
                        });
                    } else {
                        // Multiple failures — stop retrying, require manual action
                        linkFailures.delete(clientId);
                        this._emit(clientId, 'link_error', {
                            code: 'LINK_FAILED',
                            message: 'WhatsApp link failed multiple times. Please unlink unused devices from your WhatsApp account and refresh the page.',
                            retryIn: null,
                            hint: 'Settings → Linked Devices → tap each device → Unlink',
                        });
                    }
                    return; // Don't clean up — user may re-init after fixing
                }

                if (!wasIntentional) {
                    console.warn(`[Baileys] Disconnected for ${clientId}:`, JSON.stringify(lastDisconnect?.error, null, 2));
                    this._emit(clientId, 'disconnected', errMsg || 'Connection closed');
                    this._updateStatus(clientId, 'DISCONNECTED', { authenticated: false, whatsappConnected: false });
                    clients.delete(clientId);
                    sessions.delete(clientId);
                    linkFailures.delete(clientId);
                    
                    // Clear health check for this client — signal it so health check doesn't fight us
                    this._healthCheckStopped.set(clientId, true);
                    if (this.healthChecks.has(clientId)) {
                        clearInterval(this.healthChecks.get(clientId));
                        this.healthChecks.delete(clientId);
                    }

                    // Implement automatic reconnection with exponential backoff
                    const attempts = (this.reconnectAttempts.get(clientId) || 0) + 1;
                    this.reconnectAttempts.set(clientId, attempts);
                    
                    if (attempts <= 3) { // Limit to 3 retries
                        const delay = Math.min(5000 * Math.pow(2, attempts - 1), 30000); // Max 30s delay
                        console.log(`[Baileys] Scheduling reconnect for ${clientId} in ${delay}ms (attempt ${attempts})`);
                        setTimeout(() => {
                            this.initializeSession(clientId, phone).catch(err => {
                                console.error(`[Baileys] Reconnect failed for ${clientId}:`, err.message);
                            });
                        }, delay);
                    } else {
                        console.error(`[Baileys] Max reconnect attempts reached for ${clientId}`);
                        this.reconnectAttempts.delete(clientId);
                    }
                }
            }
        });

        return sock;
    }

    /**
     * Phase 1b: 8-Digit Pairing Code Flow
     *
     * WhatsApp Web-style: instead of scanning a QR, the user enters their
     * phone number on the dashboard. The server generates a unique 8-char
     * code and sends it via SMS/WhatsApp to the user's phone. They then enter
     * that code to pair — just like WhatsApp Web's "Link with phone number" flow.
     *
     * @param {string} clientId
     * @param {string} phoneNumber  — full international format e.g. +91 81780 81629
     * @param {string} [customCode] — optional 8-char code (auto-generated if omitted)
     * @returns {Promise<string>}    the 8-digit pairing code
     */
    async requestPairingCode(clientId, phoneNumber, customCode) {
        if (!clientId || !phoneNumber) {
            throw new Error('clientId and phoneNumber are required');
        }

        // Strip non-digits
        const cleanPhone = phoneNumber.replace(/\D/g, '');

        // Generate or validate 8-char code
        let code = customCode || '';
        if (!code) {
            // Generate random 8-digit code (10000000–99999999)
            code = String(Math.floor(10000000 + Math.random() * 90000000));
        }
        if (!/^\d{8}$/.test(code)) {
            throw new Error('Pairing code must be exactly 8 digits');
        }

        console.log(`[PairingCode] Generating code for ${clientId} / +${cleanPhone}`);

        // Ensure socket is initialized (triggers QR event first, then we override)
        let sock = clients.get(clientId);
        if (!sock || !sock.ws || sock.ws.readyState !== 1) {
            sock = await this.initializeSession(clientId);
        }

        try {
            // requestPairingCode in Baileys v6 sends the code via WhatsApp SMS
            // The user enters it on their phone when prompted
            const returnedCode = await sock.requestPairingCode(cleanPhone, code);
            const finalCode = returnedCode || code;

            console.log(`[PairingCode] Code sent for ${clientId}: ${finalCode}`);
            this._emit(clientId, 'pairing_code', finalCode);
            await this._updateStatus(clientId, 'PAIRING', { pairingCode: finalCode });

            return finalCode;
        } catch (err) {
            console.error(`[PairingCode] Failed for ${clientId}: ${err.message}`);

            // Fallback: generate and display code locally if SMS fails
            // (user must manually enter on their phone)
            console.warn(`[PairingCode] Falling back to manual code for ${clientId}`);
            const fallbackCode = String(Math.floor(10000000 + Math.random() * 90000000));
            this._emit(clientId, 'pairing_code', fallbackCode);
            await this._updateStatus(clientId, 'PAIRING', { pairingCode: fallbackCode });
            return fallbackCode;
        }
    }

    /**
     * Phase 1 — Post-connection handshake:
     * 1. Set user.is_onboarded = true in DB
     * 2. Lazy Sync: Fetch only last 10 active chats (names/JIDs)
     * 3. Send self-confirmation message
     */
    async _onConnected(clientId, sock) {
        try {
            const Session = require('../../models/Session');
            const waWid = sock.user?.id || '';
            const waPhone = waWid.replace('@s.whatsapp.net', '').replace('@c.us', '');

            await Session.findOneAndUpdate(
                { clientId },
                {
                    authenticated: true,
                    is_onboarded: true,
                    status: 'READY',
                    whatsappConnected: true,
                    whatsappWid: waWid,
                    phone: waPhone || undefined,
                },
                { upsert: true }
            );

            // Cross-session sync: propagate whatsappConnected to all sessions sharing the same phone
            if (waPhone) {
                await Session.updateMany(
                    { clientId: { $ne: clientId }, phone: waPhone },
                    { $set: { whatsappConnected: true, lastActive: new Date() } }
                ).catch(() => {});
            }

            console.log(`[Baileys] WhatsApp connected for ${clientId} (${waPhone || waWid}) | whatsappConnected=true`);
        } catch (e) {
            console.warn(`[Baileys] DB update skipped (no Mongo): ${e.message}`);
        }

        // Lazy sync — fetch group chats (no full message history)
        try {
            const inbox = await sock.groupFetchAllParticipating?.() || {};
            const chatList = Object.values(inbox)
                .slice(0, LAZY_SYNC_CHAT_LIMIT)
                .map(c => ({ jid: c.id, name: c.subject || c.name || c.id }));
            this._emit(clientId, 'chat_list', chatList);
        } catch (e) {
            console.warn(`[Baileys] Chat sync skipped: ${e.message}`);
        }

        // Send self-confirmation (best effort — don't block on failure)
        try {
            const jid = sock.user?.id;
            if (jid) {
                await this._sendRaw(clientId, jid, 'ConcertOS Integration Active ✅');
            }
        } catch (e) {
            console.warn(`[Baileys] Self-message skipped: ${e.message}`);
        }
    }

    // ── Phase 2: Anti-Ban Protocol ───────────────────────────────────────────

    /**
     * Phase 2 — Stealth-Human Anti-Ban: sendSafeReply
     * Applies: presence emulation, calculated latency, rate limiting,
     * and AI-powered message variability.
     *
     * @param {string} jid   — WhatsApp JID
     * @param {string} text  — Message text
     * @param {object} opts  — Optional overrides
     */
    async sendSafeReply(clientId, jid, text, opts = {}) {
        if (!clientId || !jid) return;

        // Step 1: Presence emulation — send to WhatsApp server so the other user sees "typing..."
        const sock = clients.get(clientId);
        if (sock) {
            try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
        }
        // Also emit to dashboard for real-time display
        this._emit(clientId, 'presence', { jid, type: 'composing' });

        // Step 2: Calculated latency — Delay = (CharCount × 0.1s) + Random(2000ms, 5000ms)
        const charDelay = text.length * 100;
        const randomDelay = 2000 + Math.floor(Math.random() * 3000);
        await delay(charDelay + randomDelay);

        // Step 3: Bottleneck rate limiting — per-client, max 50/hour
        const limiter = this._getClientLimiter(clientId);
        await limiter.schedule(() => {}); // Throttle to minTime spacing

        // Step 4: AI Message Variability — rephrase to prevent signature-based banning
        let finalText = text;
        if (this.groqClient && opts.variate !== false) {
            finalText = await this._variateMessage(text).catch(() => text);
        }

        // Step 5: Circuit-protected send — on failure/circuit-open, queue for retry
        return this._sendWithCircuit(clientId, jid, finalText, opts);
    }

    /**
     * AI-powered message rephrasing for anti-ban signature detection.
     * Subtle variations — keep meaning, change structure/wording.
     */
    // ── Circuit-Protected Message Variability ───────────────────────
    async _variateMessage(text) {
        if (!this.groqClient || !text) return text;

        const breaker = this._getBreaker('whatsapp:variate', {
            timeout: 8000,
            errorThresholdPercentage: 75,
            resetTimeout: 15000,
        });

        try {
            const result = await breaker.fire(async () => {
                const response = await this.groqClient.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{
                        role: 'user',
                        content: `Rephrase this WhatsApp business message with subtle wording changes. Keep the same meaning and tone. Do not add emojis or change the core message:\n\n"${text}"`
                    }],
                    max_tokens: 200,
                    temperature: 0.7,
                });
                return response.choices[0]?.message?.content?.trim() || text;
            });
            return result;
        } catch (err) {
            console.warn(`[CIRCUIT] Message variate failed for ${clientId}: ${err.message}`);
            return text; // Fallback: use original text
        }
    }

    /**
     * Check if client has remaining outbound capacity (50/hour sliding window).
     */
    _checkRateLimit(clientId) {
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;
        const msgs = pendingMessages.get(clientId) || [];
        const recentCount = msgs.filter(m => m.timestamp > hourAgo).length;
        return recentCount < MAX_OUTBOUND_PER_HOUR;
    }

    /**
     * Queue a message in Redis (BullMQ) or in-memory when rate limited.
     */
    _queueMessage(clientId, jid, text, opts = {}) {
        const queuedAt = Date.now();
        if (this.queue) {
            // BullMQ — backed by Redis
            this.queue.add('outbound', { clientId, jid, text, opts }, {
                delay: COOLDOWN_MS,
                removeOnComplete: true,
                removeOnFail: false,
            });
        } else {
            // In-memory fallback
            pendingMessages.set(clientId, [
                ...(pendingMessages.get(clientId) || []),
                { jid, text, opts, queuedAt }
            ].filter(m => m.queuedAt > Date.now() - 60 * 60 * 1000));
            // Attempt send after cooldown
            setTimeout(() => {
                if (this._checkRateLimit(clientId)) {
                    this._sendRaw(clientId, jid, text, opts);
                }
            }, COOLDOWN_MS);
        }
    }

    // ── Low-level raw send (no anti-ban wrappers) ─────────────────────────────

    async _sendRaw(clientId, jid, text, opts = {}) {
        const sock = clients.get(clientId);
        if (!sock || !sock.ws || sock.ws.readyState !== 1) {
            throw new Error(`Baileys socket not ready for ${clientId}`);
        }
        const sent = await sock.sendMessage(jid, { text }, opts);
        this._resetIdleTimer(clientId);

        // Emit to dashboard
        this._emit(clientId, 'message', {
            id: sent?.key?.id || `msg-${Date.now()}`,
            from: opts.fromMe ? jid : sock.user?.id,
            to: opts.fromMe ? sock.user?.id : jid,
            body: text,
            fromMe: true,
            timestamp: Math.floor(Date.now() / 1000),
        });

        return sent;
    }

    // ── Phase 3: Incoming Message Handler ────────────────────────────────────

    /**
     * Phase 3 — handleIncoming(msg)
     * Called by server.js when a message arrives via Baileys EVENTS.
     * Hooks into the Swarm/blackboard pipeline.
     *
     * @param {string} clientId
     * @param {object} msg — Baileys message object
     */
    async handleIncoming(clientId, msg) {
        this._resetIdleTimer(clientId);

        if (!msg?.key?.remoteJid || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || '';
        const hasMedia = !!(msg.message?.imageMessage || msg.message?.videoMessage);

        // Emit to dashboard for real-time display
        this._emit(clientId, 'message', {
            id: msg.key.id,
            from: jid,
            to: msg.key.participant || clients.get(clientId)?.user?.id,
            body: text,
            fromMe: false,
            timestamp: msg.key.timestamp,
        });

        // Return message data for upstream processing (AI router, Swarm, etc.)
        return {
            clientId,
            jid,
            text,
            hasMedia,
            pushName: msg.pushName,
            key: msg.key,
            message: msg.message,
        };
    }

    // ── Phase 3: RAM Optimization — Auto-Prune & Auto-Wake ───────────────────

    /**
     * Auto-Pruning: close idle sockets after IDLE_TIMEOUT_MS (30 min),
     * but keep auth_info on disk so they can be auto-woken.
     */
    _resetIdleTimer(clientId) {
        if (idleTimers.has(clientId)) clearTimeout(idleTimers.get(clientId));
        const timer = setTimeout(async () => {
            console.log(`[Baileys] Auto-pruning idle client: ${clientId}`);
            await this._pruneClient(clientId, keepAuth = true);
        }, IDLE_TIMEOUT_MS);
        idleTimers.set(clientId, timer);
        lastActivity.set(clientId, Date.now());
    }

    /**
     * Auto-Wake: re-initialize socket when:
     * 1. User logs into dashboard → callers call initializeSession
     * 2. Incoming message event detected → this is a no-op (Baileys keeps socket alive)
     * 3. Periodic polling (fallback for webhook-like behavior)
     */
    async wakeClient(clientId, phone) {
        if (clients.has(clientId)) {
            const sock = clients.get(clientId);
            if (sock.ws && sock.ws.readyState === 1) return sock; // Already awake
        }
        return this.initializeSession(clientId, phone);
    }

    /**
     * Prune a client's socket (close WebSocket, optionally remove auth).
     * Auth files on disk remain — allows re-auth without QR re-scan.
     */
    async _pruneClient(clientId, sessionDirKey, keepAuth = true) {
        if (idleTimers.has(clientId)) {
            clearTimeout(idleTimers.get(clientId));
            idleTimers.delete(clientId);
        }
        
        // Clear health check for this client
        if (this.healthChecks.has(clientId)) {
            clearInterval(this.healthChecks.get(clientId));
            this.healthChecks.delete(clientId);
        }
        
        // Clear reconnect attempts for this client
        this.reconnectAttempts.delete(clientId);

        const sock = clients.get(clientId);
        if (sock) {
            try { await sock.logout(); } catch (e) {}
            try { await sock.end(); } catch (e) {}
            clients.delete(clientId);
            sessions.delete(clientId);
        }

        // keepAuth=true: leave session directory intact for auto-wake
        if (!keepAuth) {
            const dirKey = sessionDirKey || clientId;
            const clientDir = path.join(SESSION_DIR, dirKey);
            if (fs.existsSync(clientDir)) {
                fs.rmSync(clientDir, { recursive: true, force: true });
            }
        }

        this._emit(clientId, 'disconnected', 'SESSION_PRUNED');
    }

    /**
     * Cleanup(): purge session files older than MAX_SESSION_AGE_MS.
     * Call periodically or on-demand. Frees AWS disk space.
     */
    async Cleanup() {
        if (!fs.existsSync(SESSION_DIR)) return;
        const now = Date.now();
        let purged = 0;
        let freedBytes = 0;

        try {
            const entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const clientPath = path.join(SESSION_DIR, entry.name);
                const stat = fs.statSync(clientPath);
                if (now - stat.mtimeMs > MAX_SESSION_AGE_MS) {
                    const size = this._dirSize(clientPath);
                    fs.rmSync(clientPath, { recursive: true, force: true });
                    purged++;
                    freedBytes += size;
                    console.log(`[Cleanup] Purged ${entry.name} (${(size / 1024).toFixed(1)} KB)`);
                }
            }
        } catch (e) {
            console.error(`[Cleanup] Error: ${e.message}`);
        }

        return { purged, freedBytes };
    }

    _dirSize(dir) {
        let size = 0;
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                const s = fs.statSync(path.join(dir, f));
                size += s.isFile() ? s.size : this._dirSize(path.join(dir, f));
            }
        } catch (e) {}
        return size;
    }

    /**
     * Periodic background pruner — scans for stale in-memory sockets
     * that may have leaked past the idle timer.
     */
    _startPruner() {
        this.pruneTimer = setInterval(async () => {
            const now = Date.now();
            for (const [clientId, last] of lastActivity) {
                if (now - last > IDLE_TIMEOUT_MS) {
                    console.log(`[Pruner] Force-pruning inactive client: ${clientId}`);
                    await this._pruneClient(clientId, keepAuth = true);
                }
            }
        }, PRUNE_INTERVAL_MS);
    }

    /**
     * Start periodic health check for a client connection
     */
    _startHealthCheck(clientId) {
        // Clear any existing health check for this client
        if (this.healthChecks.has(clientId)) {
            clearInterval(this.healthChecks.get(clientId));
        }

        // Look up the LIVE socket on every tick — don't close over a stale reference.
        // The old socket reference (passed as `sock`) becomes invalid after reconnect.
        const healthCheckInterval = setInterval(async () => {
            try {
                // If the close handler already stopped us, don't fight it
                if (this._healthCheckStopped.get(clientId)) {
                    clearInterval(healthCheckInterval);
                    this.healthChecks.delete(clientId);
                    return;
                }

                const sock = clients.get(clientId);
                if (sock?.ws?.readyState === 1) {
                    // Socket still alive — reset reconnect counter
                    this.reconnectAttempts.set(clientId, 0);
                    return;
                }

                // Socket dead — prevent concurrent reconnect loops.
                // If reconnect is already in progress, skip.
                const existingAttempts = this.reconnectAttempts.get(clientId) || 0;
                if (existingAttempts > 0) {
                    console.warn(`[HealthCheck] Reconnect already in progress for ${clientId}, skipping duplicate`);
                    return;
                }

                // Don't auto-reconnect if there are active link failures (405) — let user fix first
                if (linkFailures.has(clientId)) {
                    console.warn(`[HealthCheck] ${clientId} has active link failures — skipping auto-reconnect`);
                    return;
                }

                console.warn(`[HealthCheck] Socket invalid for ${clientId}, attempting reconnect`);
                clearInterval(healthCheckInterval);
                this.healthChecks.delete(clientId);

                this.reconnectAttempts.set(clientId, 1);
                await this.initializeSession(clientId);
            } catch (err) {
                console.warn(`[HealthCheck] Error for ${clientId}:`, err.message);
            }
        }, 30000); // Check every 30 seconds

        this.healthChecks.set(clientId, healthCheckInterval);
    }

    _emit(clientId, event, data) {
        if (!this.io) {
            console.warn(`[Baileys] _emit skipped: this.io is null (clientId=${clientId}, event=${event})`);
            return;
        }
        const room = this.io.sockets.adapter.rooms.get(clientId);
        const roomSize = room ? room.size : 0;
        if (roomSize === 0) {
            console.warn(`[Baileys] _emit: NO SOCKETS in room '${clientId}' for event '${event}' — frontend not joined?`);
        } else {
            console.log(`[Baileys] _emit: room=${clientId} event=${event} sockets_in_room=${roomSize}`);
        }
        this.io.to(clientId).emit(event, data);
    }

    async _updateStatus(clientId, status, extra = {}) {
        try {
            const Session = require('../../models/Session');
            await Session.findOneAndUpdate(
                { clientId },
                { status, lastActive: new Date(), ...extra },
                { upsert: true }
            );
            console.log(`[Baileys] DB status updated: ${clientId} → ${status}`);
        } catch (e) {
            console.error(`[Baileys] DB status update failed for ${clientId}: ${e.message}`);
        }
    }

    /**
     * Disconnect and clean up a client entirely (logout + delete auth files).
     */
    async destroySession(clientId, sessionDirKey) {
        // sessionDirKey = phone hash when phone is available; falls back to clientId for backward compat
        const dirKey = sessionDirKey || clientId;
        await this._pruneClient(clientId, dirKey, false);
        pendingMessages.delete(clientId);
        lastActivity.delete(clientId);
        linkFailures.delete(clientId);
        this._emit(clientId, 'session_purged', { clientId });
    }

    /**
     * Get current status of a client.
     */
    getStatus(clientId) {
        const sock = clients.get(clientId);
        if (!sock) return { status: 'NOT_INITIALIZED', connected: false };
        const connected = sock.ws && sock.ws.readyState === 1;
        return {
            status: connected ? 'READY' : 'CONNECTING',
            connected,
            user: sock.user ? {
                id: sock.user.id,
                name: sock.user.name,
                pushName: sock.user.pushName,
            } : null,
        };
    }

    /**
     * Get connection statistics for monitoring and debugging
     */
    getStats() {
        return {
            totalClients: clients.size,
            activeClients: Array.from(clients.entries()).filter(([_, sock]) => 
                sock.ws && sock.ws.readyState === 1).length,
            idleClients: idleTimers.size,
            queuedMessages: messageQueue.length,
            reconnectAttempts: Array.from(this.reconnectAttempts.entries()),
            healthChecks: this.healthChecks.size,
            sessions: Array.from(sessions.entries()).map(([clientId, session]) => ({
                clientId,
                initialized: session.initialized,
                lastActivity: lastActivity.get(clientId) || null
            }))
        };
    }
    
    /**
     * Graceful shutdown.
     */
    shutdown() {
        if (this.pruneTimer) clearInterval(this.pruneTimer);
        for (const [clientId] of clients) {
            this._pruneClient(clientId, keepAuth = true).catch(() => {});
        }

        // Clear all health check intervals
        for (const [clientId, interval] of this.healthChecks) {
            clearInterval(interval);
        }
        this.healthChecks.clear();

        // Clear reconnect attempts tracking
        this.reconnectAttempts.clear();

        // Close all circuit breakers
        for (const [name, breaker] of this._circuitBreakers) {
            breaker.shutdown();
        }
        this._circuitBreakers.clear();

        // Close all client rate limiters
        for (const [clientId, limiter] of this.clientLimiters) {
            limiter.disconnect();
        }
        this.clientLimiters.clear();
    }
}

module.exports = WhatsAppManager;
