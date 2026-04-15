const Groq = require("groq-sdk");
const { z } = require("zod");
const { handleFaq, handleSales, handleCustom, getConfig } = require("./agents");
const { handleVision } = require("./vision");
const { safeJsonParse } = require("./utils");
const { sanitizeAIInput } = require("./sanitize");
const { createStructuredCompletion } = require("../src/lib/instructor-groq");

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// Zod schema for intent detection response
const IntentResponseSchema = z.object({
    intent: z.enum(["FAQ", "SALES", "CUSTOM", "HANDOFF_HUMAN"]),
    profileUrl: z.union([z.string().url(), z.null()]).optional(),
    reasoning: z.string().optional(),
});

async function determineIntent(textMsg) {
    if (!process.env.GROQ_API_KEY) return { intent: 'FAQ', profileUrl: null };

    // Sanitize input before sending to LLM
    const sanitized = sanitizeAIInput(textMsg);
    if (!sanitized.text) return { intent: 'FAQ', profileUrl: null };

    try {
        const result = await createStructuredCompletion({
            messages: [
                {
                    role: "user",
                    content: sanitized.text
                }
            ],
            schema: IntentResponseSchema,
            schemaName: "IntentDetection",
            systemPrompt: `You are an intent classifier. You MUST respond with ONLY valid JSON — no explanation, no markdown, no extra text. Valid JSON with these exact fields only:\n{"intent": "FAQ|SALES|CUSTOM|HANDOFF_HUMAN", "profileUrl": "https://... or null", "reasoning": "optional string"}\n\nCategories:\n- FAQ: questions about product, pricing, collaboration\n- SALES: agreeing to collab, sharing contact/details\n- CUSTOM: specific requests, complaints, feedback\n- HANDOFF_HUMAN: angry, complex, or sensitive issues\n\nIf a social media profile link is found in the message (Instagram, TikTok, YouTube, etc.), extract it as profileUrl. Otherwise set profileUrl to null.`,
            maxRetries: 3,
        });

        if (result.fallback || !result.success) {
            console.warn("[AI-ROUTER] Intent detection failed, falling back to FAQ");
            return { intent: 'FAQ', profileUrl: null };
        }

        return {
            intent: result.data.intent,
            profileUrl: result.data.profileUrl || null
        };
    } catch (err) {
        console.error("Intent Determination Error:", err.message);
        return { intent: 'FAQ', profileUrl: null };
    }
}

async function processMessage(messageText, imageBase64, auditData = null) {
    const config = getConfig();

    // Sanitize all AI input before processing
    const sanitized = sanitizeAIInput(messageText, imageBase64);
    if (!sanitized.text && sanitized.images.length === 0) {
        return { response: null, intent: 'NONE', profileUrl: null };
    }

    // 1. Vision Bot
    const hasImages = sanitized.images.length > 0;
    if (hasImages && config.vision.isActive) {
        const visionResult = await handleVision(sanitized.images, sanitized.text, auditData);
        return {
            response: visionResult.response,
            profileUrl: visionResult.profileUrl
        };
    }

    // 2. Intent Routing
    const context = await determineIntent(sanitized.text);
    const intent = context.intent;
    const profileUrl = context.profileUrl;

    // 3. Bot Logic
    if (intent === 'SALES' && config.sales.isActive) {
        const result = await handleSales(sanitized.text, auditData);
        return { response: result.response, intent: 'SALES', qualification: result.qualification, profileUrl };
    }
    if (intent === 'CUSTOM' && config.custom.isActive) {
        const result = await handleCustom(sanitized.text, auditData);
        return { response: result.response, intent: 'CUSTOM', profileUrl };
    }
    if (intent === 'HANDOFF_HUMAN') {
        return { response: "", intent: 'HANDOFF_HUMAN', profileUrl };
    }

    // Default: FAQ (only if active)
    if (config.faq.isActive) {
        const result = await handleFaq(sanitized.text, auditData);
        return { response: result.response, intent: 'FAQ', profileUrl };
    }

    return { response: null, intent: 'NONE', profileUrl };
}


module.exports = { processMessage, determineIntent };

