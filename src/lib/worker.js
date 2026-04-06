const { Worker } = require('bullmq');
const { connection, throttledWarn } = require('./queue');
const mongoose = require('mongoose');
const { sanitizeAIInput } = require('../../ai/sanitize');

// Lazy-load models (they may already be registered)
let AIConfig, Lead;
try { AIConfig = mongoose.model('AIConfig'); } catch { AIConfig = require('../../models/AIConfig'); }
try { Lead = mongoose.model('Lead'); } catch { Lead = require('../../models/Lead'); }

// Gate: only process jobs once MongoDB is fully connected
// This prevents "Cannot call sessions.find() before initial connection" errors
let isDbReady = false;
mongoose.connection.once('connected', () => { isDbReady = true; });
mongoose.connection.on('disconnected', () => { isDbReady = false; });

/**
 * Worker to process inbound messages from WhatsApp
 * Only processes if the client has AI enabled
 */
let inboundWorker;
try {
    inboundWorker = new Worker('inbound-messages', async job => {
    // Block job until MongoDB is ready
    if (!isDbReady && mongoose.connection.readyState !== 1) {
        throw new Error('DB_NOT_READY');
    }

    const { from, text, clientId } = job.data;

    console.log(`🤖 Processing Job ${job.id} from ${from} (client: ${clientId || 'unknown'})`);

    // 1. Find the AI config for this specific client
    let config = null;
    if (clientId && clientId !== 'default') {
        config = await AIConfig.findOne({ clientId });
    }

    // 2. If AI is disabled or no config exists, skip
    if (!config || !config.aiEnabled) {
        console.log(`⏭️ [SECURITY] AI disabled or no config for client ${clientId}. Skipping reply for ${from}.`);
        return { skipped: true, reason: 'AI_DISABLED' };
    }

    // 3. Check if this chat is paused (human took over)
    const phone = from.replace(/^\+/, '');
    const lead = await Lead.findOne({ phone });
    if (lead && lead.isAiPaused) {
        console.log(`⏸️ AI paused for ${from}. Human is handling.`);
        return { paused: true };
    }

    // 4. Build the AI prompt from the client's config
    const activeAgent = config.agents.faq.isActive ? config.agents.faq :
                        config.agents.sales.isActive ? config.agents.sales :
                        config.agents.custom.isActive ? config.agents.custom : null;

    if (!activeAgent) {
        console.log(`⏭️ No active agents for client ${config.clientId}. Skipping.`);
        return { skipped: true };
    }

    try {
        const Groq = require('groq-sdk');
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const systemPrompt = `You are an AI assistant for ${config.businessName}.
${config.businessDescription ? 'About: ' + config.businessDescription : ''}
${config.businessWebsite ? 'Website: ' + config.businessWebsite : ''}
Language preference: ${config.language || 'en'}

${activeAgent.prompt}

Respond in JSON format: {"response": "your reply here"}`;

        // Sanitize AI input before sending to LLM
        const sanitized = sanitizeAIInput(text);
        if (!sanitized.text) {
            console.log(`⏭️ Sanitized empty message from ${from}. Skipping.`);
            return { skipped: true, reason: 'SANITIZED_EMPTY' };
        }

        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            response_format: { type: 'json_object' },
            temperature: 0.4,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: sanitized.text }
            ]
        });

        const parsed = JSON.parse(completion.choices[0].message.content);

        if (parsed.response) {
            // AI response logged — Baileys handles outbound via sendSafeReply in WhatsAppManager
            console.log(`✅ AI Response ready for ${from}: ${parsed.response.substring(0, 50)}...`);
        }
    } catch (error) {
        console.error(`❌ Worker Error [Job ${job.id}]:`, error.message);
        throw error;
    }
}, { connection });

    inboundWorker.on('completed', job => {
        console.log(`🎉 Job ${job.id} completed!`);
    });

    inboundWorker.on('failed', (job, err) => {
        console.error(`⚠️ Job ${job.id} failed:`, err.message);
    });

    // Throttled error logging — no more log spam
    inboundWorker.on('error', err => {
        throttledWarn("BullMQ Worker", err.message);
    });
} catch (err) {
    console.warn("⚠️ Redis unreachable. Inbound worker disabled.");
}

module.exports = inboundWorker;
