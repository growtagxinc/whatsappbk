const { OpenAI } = require("openai");

// Placeholder for now - user will need to provide this in .env
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "sk-placeholder",
});

async function qualifyLead(inquiry) {
    if (!process.env.OPENAI_API_KEY) {
        return { qualification: "NEEDS REVIEW", reason: "API Key missing" };
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `You are a professional B2B Sales Conversion Agent for 'Brand Pro Inc.' and 'ConcertOS'. 
                    Your goal is to qualify lead inquiries from IndiaMart/Google and respond in a professional yet local 'Hinglish' tone (mixed Hindi & English).
                    
                    TASK:
                    1. Analyze the inquiry for: Intent (Buying/Repair/AMC), Volume (Single unit/Bulk), and Urgency.
                    2. Categorize the lead as:
                       - HOT: Clearly ready to buy or needs urgent service (e.g., 'Need 20 ACs for office').
                       - WARM: Interested but needs more info or has a flexible timeline.
                       - COLD: Just asking for price with no specific requirement.
                    3. Return a JSON object: { "qualification": "HOT/WARM/COLD", "reason": "Short explanation", "suggested_response": "The WhatsApp message to send in Hinglish" }`
                },
                {
                    role: "user",
                    content: inquiry
                }
            ],
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (err) {
        console.error("AI Qualification failed:", err);
        return { qualification: "MANUAL", reason: "AI error" };
    }
}

module.exports = { qualifyLead };
