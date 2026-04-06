/**
 * Safely parses JSON response from AI, stripping common markdown or unescaped characters.
 */
function safeJsonParse(rawText) {
    if (!rawText) return null;
    
    // 1. Strip Markdown backticks if present
    let text = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    
    try {
        return JSON.parse(text);
    } catch (err) {
        console.warn("Initial JSON.parse failed. Raw text snippet:", text.substring(0, 100));
        console.warn("Error message:", err.message);
        
        // 2. Aggressive regex-based extraction if standard parse fails
        try {
            // Attempt to find the specific fields we care about if it's a completely broken JSON
            const responseMatch = text.match(/"response"\s*:\s*"([\s\S]*?)"(?=\s*[,\}])/);
            const intentMatch = text.match(/"intent"\s*:\s*"([\s\S]*?)"(?=\s*[,\}])/);
            const scoreMatch = text.match(/"score"\s*:\s*(\d+)/);
            
            if (responseMatch) {
                console.log("Regex fallback successful for 'response'");
                return {
                    response: responseMatch[1],
                    intent: intentMatch ? intentMatch[1] : undefined,
                    score: scoreMatch ? parseInt(scoreMatch[1]) : undefined
                };
            }
        } catch (regexErr) {
            console.error("Regex fallback also failed:", regexErr.message);
        }
        
        // 3. Last resort: just return the raw text as the response if it looks like plain text
        if (text.length > 0 && !text.startsWith('{')) {
            return { response: text };
        }

        throw err; 
    }
}

module.exports = { safeJsonParse };
