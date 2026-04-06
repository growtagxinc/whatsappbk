const Groq = require("groq-sdk");
const { safeJsonParse } = require("./utils");
const { sanitizeMessage } = require("./sanitize");

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// In-memory config — Concertos AI Agent System
const aiConfig = {
    faq: {
        name: "FAQ Assistant",
        description: "Handles product questions, pricing queries, and feature questions.",
        prompt: `You are Concertos' WhatsApp AI Assistant — an AI-powered WhatsApp CRM for Indian SMBs.
Help the user with questions about: your business's products/services, pricing, features, delivery, support.
Use the audit data provided to personalize answers. Be friendly, use Hinglish if appropriate, and never be robotic.`,
        isActive: true
    },
    sales: {
        name: "Sales Conversion Agent",
        description: "Qualifies leads and nurtures them toward booking a call or purchase.",
        prompt: `You are Concertos' Sales AI Agent. Help qualify inbound WhatsApp leads.
Ask qualifying questions naturally: business type, team size, current WhatsApp usage, pain points.
Suggest the right plan (Starter ₹999/mo, Pro ₹2,999/mo, Enterprise ₹9,999/mo).
Always move toward: booking a demo call or starting a free trial.
Keep responses concise and friendly. Use Hinglish if it feels natural.`,
        isActive: true
    },
    vision: {
        name: "Visual Analyst",
        description: "Analyzes screenshots, QR codes, and product images.",
        prompt: `You are Concertos' AI Visual Analyst. Analyze the provided screenshot or image.
Extract: product names, prices, phone numbers, URLs, order details, or any relevant business information.
If a QR code is present, decode it and explain what it leads to.
Be concise — describe what's in the image in 2-3 sentences.`,
        isActive: true
    },
    custom: {
        name: "Campaign Coordinator",
        description: "Handles order updates, campaign coordination, and customer support.",
        prompt: `You are Concertos' AI Campaign Coordinator. Help with:
- Order status and delivery updates
- Campaign brief review and feedback
- Appointment scheduling and reminders
- General customer support queries
Use audit data to personalize. Be warm and professional.`,
        isActive: true
    }
};

async function handleFaq(userMessage, auditData = null) {
    if (!process.env.GROQ_API_KEY) return { response: "API Key Missing", intent: 'FAQ' };
    if (!aiConfig.faq.isActive) return { response: null, intent: 'FAQ' };

    const sanitized = sanitizeMessage(userMessage);
    if (!sanitized.clean) return { response: null, intent: 'FAQ' };

    let auditContext = auditData ? `\n\nCREATOR CONTEXT: Niche: ${auditData.bio}, Followers: ${auditData.followersText}.` : "";
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.4,
            messages: [
                { role: "system", content: aiConfig.faq.prompt + auditContext + "\nOutput JSON: {\"response\": \"...\"}" },
                { role: "user", content: sanitized.clean }
            ],
        });
        const parsed = safeJsonParse(completion.choices[0].message.content);
        return { response: parsed.response || "No response", intent: 'FAQ' };
    } catch (err) { return { response: "Technical hiccup! 😅", intent: 'FAQ' }; }
}

async function handleSales(userMessage, auditData = null) {
    if (!process.env.GROQ_API_KEY) return { response: "API Key Missing", intent: 'SALES' };
    if (!aiConfig.sales.isActive) return { response: null, intent: 'SALES' };

    const sanitized = sanitizeMessage(userMessage);
    if (!sanitized.clean) return { response: null, intent: 'SALES' };

    let auditContext = auditData ? `\n\nCREATOR CONTEXT: Niche: ${auditData.bio}, Followers: ${auditData.followersText}.` : "";
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.4,
            messages: [
                { role: "system", content: aiConfig.sales.prompt + auditContext + "\nOutput JSON: {\"response\": \"...\", \"qualification\": \"HOT/WARM/COLD\"}" },
                { role: "user", content: sanitized.clean }
            ],
        });
        return safeJsonParse(completion.choices[0].message.content);
    } catch (err) { return { response: "Let's collab! 🚀", intent: 'SALES', qualification: 'WARM' }; }
}

async function handleCustom(userMessage, auditData = null) {
    if (!process.env.GROQ_API_KEY) return { response: "API Key Missing", intent: 'CUSTOM' };
    if (!aiConfig.custom.isActive) return { response: null, intent: 'CUSTOM' };

    const sanitized = sanitizeMessage(userMessage);
    if (!sanitized.clean) return { response: null, intent: 'CUSTOM' };

    let auditContext = auditData ? `\n\nCREATOR CONTEXT: Niche: ${auditData.bio}, Followers: ${auditData.followersText}.` : "";
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" },
            temperature: 0.7,
            messages: [
                { role: "system", content: aiConfig.custom.prompt + auditContext + "\nOutput JSON: {\"response\": \"...\"}" },
                { role: "user", content: sanitized.clean }
            ],
        });
        return safeJsonParse(completion.choices[0].message.content);
    } catch (err) { return { response: "Got it! ✨", intent: 'CUSTOM' }; }
}

function updateConfig(type, updates) {
    if (aiConfig[type]) {
        if (updates.prompt !== undefined) aiConfig[type].prompt = updates.prompt;
        if (updates.isActive !== undefined) aiConfig[type].isActive = updates.isActive;
    }
}
function getConfig() { return aiConfig; }

module.exports = { handleFaq, handleSales, handleCustom, updateConfig, getConfig };

