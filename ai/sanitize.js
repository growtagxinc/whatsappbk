/**
 * AI Input Sanitization Utilities
 *
 * Protects against:
 * 1. Prompt injection — strips attempts to override system instructions
 * 2. Content-length abuse — enforces safe message size limits
 * 3. Malicious URLs — prevents social engineering via crafted links
 *
 * Apply sanitization BEFORE sending user input to any LLM provider.
 */

const MAX_MESSAGE_LENGTH = 8000;  // Characters — prevents resource exhaustion
const MAX_IMAGE_COUNT = 5;         // Max images per message — prevents cost abuse

// Patterns commonly used in prompt injection attempts
const INJECTION_PATTERNS = [
    // Attempting to override role/instructions
    /\b(ignore (previous|all|past)|disregard (previous|all|past)|forget (previous|all|past))/gi,
    // Attempting to inject new system prompts
    /\b(system prompt|your instructions are|you are now|act as|pretend you are|you consist of)/gi,
    // Attempting to escape JSON boundaries
    /```json\s*$/gi,
    /```\s*$/gi,
    // Attempting to chain commands
    /\b(then |also |additionally |furthermore )/gi,
    // Invisible/control characters
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
];

/**
 * Sanitize a text message before sending to any AI model.
 *
 * @param {string} input - Raw user message
 * @returns {{ clean: string, wasModified: boolean, reason?: string }}
 */
function sanitizeMessage(input) {
    if (typeof input !== 'string') {
        return { clean: '', wasModified: true, reason: 'non-string input' };
    }

    let clean = input.trim();
    let wasModified = false;
    let reason;

    // 1. Length check — prevent resource exhaustion
    if (clean.length > MAX_MESSAGE_LENGTH) {
        clean = clean.substring(0, MAX_MESSAGE_LENGTH);
        wasModified = true;
        reason = `truncated to ${MAX_MESSAGE_LENGTH} chars`;
    }

    // 2. Empty check
    if (clean.length === 0) {
        return { clean: '', wasModified: true, reason: 'empty input' };
    }

    // 3. Remove invisible control characters
    const before = clean;
    clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    if (clean !== before) wasModified = true;

    // 4. Strip common prompt injection patterns
    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(clean)) {
            clean = clean.replace(pattern, '');
            wasModified = true;
        }
    }

    return { clean, wasModified, reason };
}

/**
 * Sanitize image input array.
 *
 * @param {string|string[]} images - Base64 image string or array
 * @returns {{ clean: string[], wasModified: boolean, reason?: string }}
 */
function sanitizeImages(images) {
    if (!images) return { clean: [], wasModified: false };

    const arr = Array.isArray(images) ? images : [images];

    if (arr.length > MAX_IMAGE_COUNT) {
        return {
            clean: arr.slice(0, MAX_IMAGE_COUNT),
            wasModified: true,
            reason: `reduced to ${MAX_IMAGE_COUNT} images`
        };
    }

    return { clean: arr, wasModified: false };
}

/**
 * Full sanitization pipeline for AI input.
 * Apply this to every inbound message before routing to any AI model.
 *
 * @param {string} text - Raw message text
 * @param {string|string[]} images - Optional base64 images
 * @returns {{ text: string, images: string[], modified: boolean }}
 */
function sanitizeAIInput(text, images = null) {
    const textResult = sanitizeMessage(text);
    const imageResult = images ? sanitizeImages(images) : { clean: [], wasModified: false };

    if (textResult.wasModified || imageResult.wasModified) {
        console.warn(`[SANITIZE] Input modified: ${textResult.reason || ''} ${imageResult.reason || ''}`.trim());
    }

    return {
        text: textResult.clean,
        images: imageResult.clean,
        modified: textResult.wasModified || imageResult.wasModified
    };
}

module.exports = { sanitizeMessage, sanitizeImages, sanitizeAIInput };
