const Groq = require('groq-sdk');
const { getSwarmManager } = require('./SwarmManager');
const Signal = require('../models/Signal');
const AgentState = require('../models/AgentState');
const { isRedisAvailable } = require('../src/lib/queue');

/**
 * HeartbeatLoop — The CEO Agent's Recurring Scan
 * 
 * Architecture:
 * 1. PULSE:  Every 5 minutes, scan the Blackboard for stale PENDING signals
 * 2. DECOMPOSE: CEO uses Groq to analyze and break down complex signals
 * 3. ASSIGN: Route decomposed signals to specialized Worker Lobes
 * 4. AUDIT: Log every decision with reasoning_path and confidence_score
 * 
 * This runs as a setInterval (no BullMQ dependency) to ensure it works
 * even when Redis is offline.
 */

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const STALE_THRESHOLD_MS = 2 * 60 * 1000;     // 2 minutes = "stale"

let groq = null;
if (process.env.GROQ_API_KEY) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
}

let heartbeatTimer = null;
let isRunning = false;

/**
 * Execute one heartbeat pulse for a specific client.
 */
async function pulseForClient(clientId) {
    const swarm = getSwarmManager();
    
    // 1. Scan Blackboard for stale PENDING signals
    const staleSignals = await swarm.scanBlackboard(clientId, {
        statuses: ['PENDING'],
        olderThan: STALE_THRESHOLD_MS,
        limit: 20
    });

    if (staleSignals.length === 0) return { processed: 0 };

    console.log(`💓 [HEARTBEAT] Found ${staleSignals.length} stale signals for client ${clientId}`);

    // 2. Use CEO Agent reasoning to analyze and route
    const ceoAgent = await AgentState.findOne({ 
        clientId, 
        role: 'CEO' 
    });

    if (!ceoAgent) {
        console.log(`⚠️ [HEARTBEAT] No CEO agent found for client ${clientId}. Initializing swarm...`);
        await swarm.initializeSwarm(clientId);
        return { processed: 0, action: 'swarm_initialized' };
    }

    // 3. CEO reasoning — analyze each stale signal
    let processed = 0;
    for (const signal of staleSignals) {
        try {
            const decision = await ceoDecide(signal, ceoAgent);
            
            if (decision.action === 'ASSIGN') {
                // Route to the appropriate agent
                const targetAgentId = `${clientId}:${decision.targetRole}`;
                const claimed = await swarm.claimSignal(signal._id, targetAgentId);
                if (claimed) {
                    await Signal.findByIdAndUpdate(signal._id, {
                        reasoning_path: decision.reasoning,
                        confidence_score: decision.confidence
                    });
                    processed++;
                }
            } else if (decision.action === 'DECOMPOSE') {
                // Break into sub-signals
                await swarm.decomposeSignal(signal._id, decision.subSignals);
                await swarm.resolveSignal(
                    signal._id, 
                    { decomposed: true, children: decision.subSignals.length },
                    decision.reasoning,
                    decision.confidence
                );
                processed++;
            } else if (decision.action === 'ESCALATE') {
                await swarm.escalateSignal(signal._id, decision.reasoning);
                processed++;
            } else if (decision.action === 'EXPIRE') {
                await Signal.findByIdAndUpdate(signal._id, { 
                    status: 'EXPIRED',
                    reasoning_path: decision.reasoning 
                });
                processed++;
            }
        } catch (err) {
            console.error(`❌ [HEARTBEAT] Error processing signal ${signal._id}:`, err.message);
        }
    }

    // 4. Update CEO heartbeat timestamp
    await AgentState.findOneAndUpdate(
        { agentId: ceoAgent.agentId },
        { lastHeartbeat: new Date() }
    );

    console.log(`💓 [HEARTBEAT] Processed ${processed}/${staleSignals.length} signals for ${clientId}`);
    return { processed, total: staleSignals.length };
}

/**
 * CEO Decision Engine — uses Groq to analyze a signal and decide routing.
 */
async function ceoDecide(signal, ceoAgent) {
    // Fallback if Groq is unavailable — use rule-based routing
    if (!groq) {
        return ruleBasedDecision(signal);
    }

    try {
        const signalSummary = JSON.stringify({
            type: signal.type,
            source: signal.source,
            payload: truncatePayload(signal.payload),
            age: Math.round((Date.now() - new Date(signal.createdAt).getTime()) / 1000) + 's',
            priority: signal.priority
        });

        const completion = await groq.chat.completions.create({
            model: ceoAgent.contract.model || 'llama-3.3-70b-versatile',
            response_format: { type: 'json_object' },
            temperature: ceoAgent.contract.temperature || 0.2,
            messages: [
                {
                    role: 'system',
                    content: `${ceoAgent.contract.systemPrompt}

You are analyzing a stale signal on the Blackboard. Decide what to do with it.

Available Worker Lobes: SALES (handles messages, leads), OPS (handles logistics, campaigns), FINANCE (handles payments, settlements).

Output JSON:
{
    "action": "ASSIGN" | "DECOMPOSE" | "ESCALATE" | "EXPIRE",
    "targetRole": "SALES" | "OPS" | "FINANCE" (only for ASSIGN),
    "reasoning": "Why you chose this action",
    "confidence": 0.0-1.0,
    "subSignals": [{"type": "...", "payload": {...}}] (only for DECOMPOSE)
}`
                },
                {
                    role: 'user',
                    content: `Analyze this stale signal:\n${signalSummary}`
                }
            ]
        });

        const parsed = JSON.parse(completion.choices[0].message.content);
        return {
            action: parsed.action || 'ASSIGN',
            targetRole: parsed.targetRole || 'SALES',
            reasoning: parsed.reasoning || 'CEO auto-routing',
            confidence: parsed.confidence || 0.7,
            subSignals: parsed.subSignals || []
        };
    } catch (err) {
        console.error('❌ [CEO] Groq inference failed, falling back to rules:', err.message);
        return ruleBasedDecision(signal);
    }
}

/**
 * Rule-based fallback when Groq is unavailable.
 */
function ruleBasedDecision(signal) {
    const typeRouting = {
        'INBOUND_MESSAGE': { action: 'ASSIGN', targetRole: 'SALES', confidence: 0.9 },
        'LEAD_QUALIFIED': { action: 'ASSIGN', targetRole: 'SALES', confidence: 0.85 },
        'CAMPAIGN_EVENT': { action: 'ASSIGN', targetRole: 'OPS', confidence: 0.88 },
        'INVENTORY_LOW': { action: 'ASSIGN', targetRole: 'OPS', confidence: 0.92 },
        'PAYMENT_PENDING': { action: 'ASSIGN', targetRole: 'FINANCE', confidence: 0.95 },
        'SYSTEM_ALERT': { action: 'ESCALATE', confidence: 0.5 },
    };

    const route = typeRouting[signal.type] || { action: 'ESCALATE', confidence: 0.4 };
    
    return {
        ...route,
        reasoning: `Rule-based routing: ${signal.type} → ${route.targetRole || 'HUMAN'}`,
        subSignals: []
    };
}

/**
 * Truncate payload for LLM context window efficiency.
 */
function truncatePayload(payload) {
    if (!payload) return {};
    const str = JSON.stringify(payload);
    if (str.length > 500) {
        return JSON.parse(str.substring(0, 500) + '..."}}');
    }
    return payload;
}

/**
 * Start the global heartbeat loop.
 * Scans ALL clients with active swarms.
 */
function startHeartbeat() {
    if (heartbeatTimer) {
        console.log('⚠️ [HEARTBEAT] Already running');
        return;
    }

    console.log(`💓 [HEARTBEAT] CEO Heartbeat started (interval: ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
    
    heartbeatTimer = setInterval(async () => {
        if (isRunning) {
            console.log('⚠️ [HEARTBEAT] Previous pulse still running, skipping');
            return;
        }

        isRunning = true;
        try {
            // Find all unique clientIds with active agents
            const clients = await AgentState.distinct('clientId', { 
                status: { $in: ['ACTIVE', 'IDLE'] } 
            });

            for (const clientId of clients) {
                await pulseForClient(clientId);
            }
        } catch (err) {
            console.error('❌ [HEARTBEAT] Global pulse error:', err.message);
        } finally {
            isRunning = false;
        }
    }, HEARTBEAT_INTERVAL_MS);

    // Run first pulse after 30 seconds (give server time to boot)
    setTimeout(async () => {
        try {
            const clients = await AgentState.distinct('clientId');
            for (const clientId of clients) {
                await pulseForClient(clientId);
            }
        } catch (err) {
            console.error('❌ [HEARTBEAT] Initial pulse error:', err.message);
        }
    }, 30000);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log('🛑 [HEARTBEAT] CEO Heartbeat stopped');
    }
}

module.exports = { startHeartbeat, stopHeartbeat, pulseForClient };
