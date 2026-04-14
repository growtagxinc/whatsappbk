const { z } = require("zod");
const { getConfig } = require("./agents");
const { safeJsonParse } = require("./utils");

// Zod schema for vision analysis response
const VisionResponseSchema = z.object({
    response: z.string(),
    profileUrl: z.union([z.string().url(), z.null()]).optional(),
});

// Accepts a single image string OR an array of image strings
async function handleVision(imageInput, textPrompt = "Analyze all the images sent in this conversation.", auditData = null) {
    if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("Missing OPENROUTER_API_KEY");
    }

    try {
        const configPrompt = getConfig().visionPrompt;

        // Normalize to array
        const images = Array.isArray(imageInput) ? imageInput : [imageInput];
        const imageCount = images.length;

        // Unified Context Construction
        let auditContext = "";
        if (auditData) {
            auditContext = `\n\nLIVE PROFILE AUDIT DATA (Verified):
- Followers: ${auditData.followersText}
- Bio: ${auditData.bio}
- Scanned URL: ${auditData.url}
Note: If this verified data contradicts the screenshots, PRIORITIZE this verified data.`;
        }

        const promptTemplate = `${configPrompt}${auditContext}\n\nUser Message/Prompt: "${textPrompt}"\n\nTotal images in this conversation: ${imageCount}. Analyze ALL of them together before responding.\n\nSPECIAL INSTRUCTION: If any image is a QR code or contains a social media profile URL, decode the URL and return it in your JSON.\n\nOutput JSON ONLY: {"response": "...", "profileUrl": "https://instagram.com/user"}`;

        // Build content array for OpenRouter vision model
        const contentParts = [
            { type: "text", text: promptTemplate }
        ];

        for (const img of images) {
            // OpenRouter/OpenAI expects the full base64 string including the data URI scheme
            contentParts.push({
                type: "image_url",
                image_url: { url: img }
            });
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "HTTP-Referer": "https://brandpro-crm.com", 
                "X-Title": "BrandPro CRM", 
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "model": "google/gemini-2.0-flash-001",
                "temperature": 0.1,
                "messages": [
                    {
                        "role": "user",
                        "content": contentParts
                    }
                ]
            })
        });

        clearTimeout(timeoutId);

        const completion = await response.json();
        
        if (completion.error) {
            console.error("OpenRouter API Error:", completion.error.message);
            throw new Error(completion.error.message);
        }

        let text = completion.choices[0].message.content;
        const parsed = safeJsonParse(text);

        // Validate LLM output against Zod schema
        const validated = VisionResponseSchema.safeParse(parsed);
        if (!validated.success) {
            console.warn("[VISION] AI output validation failed:", validated.error.message);
            return { response: "Sorry, I couldn't process the images properly.", profileUrl: null };
        }

        return {
            response: validated.data.response || "No response generated.",
            profileUrl: validated.data.profileUrl || null
        };
    } catch (err) {
        console.error("Vision AI Error:", err);
        return { response: "Sorry, I couldn't process the images.", profileUrl: null };
    }
}

module.exports = { handleVision };
