const Groq = require('groq-sdk');
const Signal = require('../models/Signal');
const AgentState = require('../models/AgentState');
const { sanitizeMessage } = require('../ai/sanitize');

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

/**
 * AgentExecutor — Executes a claimed signal for a specific agent.
 */
class AgentExecutor {
    constructor(swarmManager) {
        this.swarm = swarmManager;
    }

    /**
     * Start the execution of a signal.
     * This is non-blocking (fire and forget from SwarmManager's perspective).
     */
    async executeSignal(signalId, agentId) {
        try {
            const signal = await Signal.findById(signalId);
            const agent = await AgentState.findOne({ agentId });

            if (!signal || !agent) return;
            if (signal.status !== 'CLAIMED') return;

            console.log(`🧠 [EXECUTOR] Agent ${agentId} starting execution for signal ${signalId}...`);

            // If Groq is not configured, we simulate execution or fail.
            if (!groq) {
                await this.swarm.resolveSignal(
                    signal._id, 
                    { reply: "Groq API key missing. Simulated response." }, 
                    "Simulated execution due to missing API key.", 
                    1.0
                );
                return;
            }

            // Execute logic based on Agent config and Signal payload
            const result = await this._runInference(signal, agent);

            // Handle confidence threshold
            if (result.confidence < agent.contract.confidenceThreshold) {
                await this.swarm.escalateSignal(
                    signal._id, 
                    `Confidence score (${result.confidence}) below threshold (${agent.contract.confidenceThreshold})`
                );
                return;
            }

            // Resolve the signal
            await this.swarm.resolveSignal(
                signal._id, 
                result.actionPayload, 
                result.reasoning, 
                result.confidence
            );

            // Side-effects (like sending WhatsApp message)
            await this._handleSideEffects(signal, result, agent);

        } catch (error) {
            console.error(`❌ [EXECUTOR] Error executing signal ${signalId}:`, error);
            await this.swarm.escalateSignal(signalId, `Execution error: ${error.message}`);
        }
    }

    async _runInference(signal, agent) {
        // Sanitize text fields in payload before sending to LLM
        const safePayload = { ...signal.payload };
        if (typeof safePayload.body === 'string') {
            safePayload.body = sanitizeMessage(safePayload.body).clean;
        }
        if (typeof safePayload.text === 'string') {
            safePayload.text = sanitizeMessage(safePayload.text).clean;
        }

        // Construct the context to pass to the LLM
        const promptContext = `
${agent.contract.systemPrompt}

Current Signal to process:
Type: ${signal.type}
Payload: ${JSON.stringify(safePayload)}

Respond with a JSON object ONLY:
{
    "confidence": 0.0 to 1.0 (How confident are you in this action?),
    "reasoning": "Explain step-by-step why you took this action",
    "actionType": "REPLY" | "UPDATE_CRM" | "IGNORE",
    "actionPayload": { ... data for the action ... }
}
`;

        try {
            const completion = await groq.chat.completions.create({
                model: agent.contract.model || 'llama-3.3-70b-versatile',
                response_format: { type: 'json_object' },
                temperature: agent.contract.temperature || 0.4,
                messages: [{ role: 'system', content: promptContext }],
            });

            const parsed = JSON.parse(completion.choices[0].message.content);
            return {
                confidence: parsed.confidence || 0.5,
                reasoning: parsed.reasoning || "Executed without specific reasoning provided.",
                actionType: parsed.actionType || "IGNORE",
                actionPayload: parsed.actionPayload || {}
            };
        } catch (err) {
            throw new Error(`Inference Failed: ${err.message}`);
        }
    }

    async _handleSideEffects(signal, result, agent) {
        // Depending on actionType and agent role, perform real-world actions
        if (result.actionType === 'REPLY' && result.actionPayload.text) {
            const chatId = signal.payload.from;
            // Example of how we might send a message back:
            // This assumes we have access to the WhatsApp client or Meta API here.
            // For now, we simulate this or rely on a centralized outbound queue.
            
            // Post an OUTBOUND_MESSAGE signal so the system is aware
            await this.swarm.postSignal('OUTBOUND_MESSAGE', {
                to: chatId,
                text: result.actionPayload.text
            }, signal.clientId, {
                source: 'agent_executor',
                sourceId: signal._id
            });
            
            // In a complete implementation, this would push to an outbound BullMQ queue
            // to actually transmit the message via WhatsApp Web / Cloud API.
            const { pushOutbound } = require('../src/lib/queue');
            pushOutbound({ 
                clientId: signal.clientId, 
                to: chatId, 
                text: result.actionPayload.text 
            }).catch(() => console.log('Notice: Outbound queue unavailable.'));
            
            console.log(`📤 [EXECUTOR] Action: Agent ${agent.agentId} replied to ${chatId}`);
        }
    }
}

let _executor = null;
function getAgentExecutor(swarmManager) {
    if (!_executor) {
         _executor = new AgentExecutor(swarmManager);
    }
    return _executor;
}

module.exports = { getAgentExecutor };
