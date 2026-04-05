const Groq = require("groq-sdk");
const { handleFaq, handleSales, handleCustom, getConfig } = require("./agents");
const { handleVision } = require("./vision");
const { safeJsonParse } = require("./utils");
const { sanitizeAIInput } = require("./sanitize");

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

async function determineIntent(textMsg) {
    if (!process.env.GROQ_API_KEY) return { intent: 'FAQ', profileUrl: null };

    // Sanitize input before sending to LLM
    const sanitized = sanitizeAIInput(textMsg);
    if (!sanitized.text) return { intent: 'FAQ', profileUrl: null };

    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.1,
            messages: [
                {
                    role: "system",
                    content: "Determine the intent of the user message. Categories: FAQ (questions about product/collab), SALES (agreeing to collab, sharing details), CUSTOM (specific requests/complaints), HANDOFF_HUMAN (angry/complex). \n\nIMPORTANT: If the message contains a social media profile link (Instagram, TikTok, YouTube, etc.), extract it and return it in the JSON.\n\nOutput JSON ONLY: {\"intent\": \"...\", \"profileUrl\": \"https://...\"}"
                },
                {
                    role: "user",
                    content: sanitized.text
                }
            ],
        });

        let text = completion.choices[0].message.content;
        const parsed = safeJsonParse(text);

        return {
            intent: parsed.intent || 'FAQ',
            profileUrl: parsed.profileUrl || null
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

