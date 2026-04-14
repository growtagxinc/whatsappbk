/**
 * Instructor + Groq Adapter for ConcertOS
 *
 * Wraps Groq SDK calls with Instructor for structured output + automatic retry logic.
 * Instructor validates LLM responses against Zod schemas and retries on parse failure.
 *
 * Usage:
 *   const { createStructuredCompletion } = require('./instructor-groq');
 *   const result = await createStructuredCompletion({
 *       messages,
 *       schema: intentResponseSchema,
 *       schemaName: 'IntentDetection',
 *       model: 'llama-3.3-70b-versatile',
 *       maxRetries: 3,
 *   });
 */

const Groq = require('groq-sdk');
const { z } = require('zod');

// Initialize Groq client (singleton)
const groq = process.env.GROQ_API_KEY
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

/**
 * Create a structured LLM completion with Zod validation + retry logic.
 * Falls back to human handoff after maxRetries failures.
 *
 * @param {Object} options
 * @param {Array<{role: string, content: string}>} options.messages - Chat messages
 * @param {import('zod').ZodSchema} options.schema - Zod schema to validate against
 * @param {string} options.schemaName - Human-readable name for error logging
 * @param {string} [options.model='llama-3.3-70b-versatile'] - Groq model
 * @param {number} [options.maxRetries=3] - Max retry attempts on parse failure
 * @param {number} [options.temperature=0.1] - Model temperature
 * @param {string} [options.systemPrompt] - Optional system prompt override
 */
async function createStructuredCompletion({
    messages,
    schema,
    schemaName,
    model = 'llama-3.3-70b-versatile',
    maxRetries = 3,
    temperature = 0.1,
    systemPrompt = null,
}) {
    if (!groq) {
        throw new Error('GROQ_API_KEY not configured');
    }

    // Build system message
    const systemMessage = systemPrompt
        ? { role: 'system', content: systemPrompt }
        : {
            role: 'system',
            content: `You must respond with valid JSON only. The JSON must conform to this schema: ${schemaName}.`,
        };

    const allMessages = [systemMessage, ...messages];

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const completion = await groq.chat.completions.create({
                model,
                response_format: { type: 'json_object' },
                temperature,
                messages: allMessages,
            });

            const rawOutput = completion.choices[0]?.message?.content;
            if (!rawOutput) {
                throw new Error('Empty response from Groq');
            }

            // Parse JSON string to object
            let parsed;
            try {
                parsed = JSON.parse(rawOutput);
            } catch {
                throw Object.assign(new Error('Invalid JSON from model'), { rawOutput });
            }

            // Validate against Zod schema
            const result = schema.safeParse(parsed);
            if (!result.success) {
                // Add context for next retry
                const context = `Previous parse attempt failed. Schema violations: ${result.error.message}`;
                allMessages.push({
                    role: 'assistant',
                    content: rawOutput,
                });
                allMessages.push({
                    role: 'user',
                    content: `Your previous response was invalid. Error: ${result.error.message}. Please respond with valid JSON matching the ${schemaName} schema.`,
                });

                console.warn(
                    `[INSTRUCTOR-GROQ] Attempt ${attempt} failed for ${schemaName}:`,
                    result.error.message
                );
                lastError = result.error;
                continue; // retry
            }

            return {
                data: result.data,
                raw: rawOutput,
                attempts: attempt,
                success: true,
            };
        } catch (err) {
            lastError = err;

            // Non-retryable errors: network, API key, timeout
            if (err.message?.includes('API key') || err.message?.includes('timeout') || err.code === 'ETIMEDOUT') {
                throw err;
            }

            // For parse errors and other retryable issues, retry
            console.warn(`[INSTRUCTOR-GROQ] Attempt ${attempt} error for ${schemaName}:`, err.message);
        }
    }

    // All retries exhausted — fall back to human handoff
    console.error(
        `[INSTRUCTOR-GROQ] All ${maxRetries} attempts failed for ${schemaName}. Falling back to human.`,
        lastError?.message
    );

    return {
        data: null,
        raw: null,
        attempts: maxRetries,
        success: false,
        fallback: true,
        error: lastError,
    };
}

/**
 * Simple wrapper for non-structured LLM calls (existing pattern).
 * Wraps groq.chat.completions.create with error handling + timeout.
 *
 * @param {Object} options
 * @param {string} options.model
 * @param {Array} options.messages
 * @param {number} [options.timeout=30000]
 */
async function createCompletion({ model, messages, timeout = 30000 }) {
    if (!groq) {
        throw new Error('GROQ_API_KEY not configured');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const completion = await groq.chat.completions.create(
            {
                model,
                messages,
            },
            { signal: controller.signal }
        );

        clearTimeout(timeoutId);
        return completion;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error(`Groq request timed out after ${timeout}ms`);
        }
        throw err;
    }
}

module.exports = {
    createStructuredCompletion,
    createCompletion,
};