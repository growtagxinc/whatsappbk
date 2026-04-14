const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const AgentState = require('../models/AgentState');
const { getAgentExecutor } = require('./AgentExecutor');

// Redlock for distributed locking (prevents race conditions in signal claiming)
let Redlock = null;
try {
    Redlock = require('redlock');
} catch (e) {
    // redlock not available — will use MongoDB atomic operations as fallback
}

const LOCK_TTL_MS = 5000;  // 5s lock — signals should be claimed quickly
const LOCK_RETRY_COUNT = 2;
const LOCK_RETRY_DELAY = 200; // ms

/**
 * SwarmManager — The Blackboard Orchestrator
 * 
 * This is the nervous system of ConcertOS v2.0.
 * It manages the flow of Signals through the Blackboard:
 *   Post → Claim → Process → Resolve/Escalate
 * 
 * All actions are atomic and auditable.
 */
class SwarmManager {
    constructor(io = null) {
        this.io = io;  // Socket.io instance for real-time frontend updates
    }

    /**
     * Post a new Signal to the Blackboard
     * This is the ONLY way events enter the system.
     */
    async postSignal(type, payload, clientId, options = {}) {
        const signal = await Signal.create({
            clientId,
            type,
            payload,
            source: options.source || 'system',
            sourceId: options.sourceId || null,
            priority: options.priority || this._getDefaultPriority(type),
            parentSignalId: options.parentSignalId || null
        });

        console.log(`📡 [BLACKBOARD] Signal posted: ${type} (${signal._id}) for client ${clientId}`);

        // Notify frontend via Socket.io
        if (this.io) {
            this.io.to(clientId).emit('signal:new', {
                id: signal._id,
                type: signal.type,
                status: signal.status,
                priority: signal.priority,
                createdAt: signal.createdAt
            });
        }

        // Auto-route: find an agent subscribed to this signal type
        await this._autoRoute(signal);

        return signal;
    }

    /**
     * Claim a Signal — distributed lock + atomic update to prevent race conditions.
     * When Redis is available: uses Redlock for distributed locking.
     * Fallback: MongoDB findOneAndUpdate atomic operation.
     */
    async claimSignal(signalId, agentId, redisClient = null) {
        let claimedSignal = null;

        // ── Redlock path: distributed lock via Redis ──────────────
        if (Redlock && redisClient) {
            try {
                const redlock = new Redlock([redisClient], {
                    driftFactor: 0.01,
                    retryCount: LOCK_RETRY_COUNT,
                    retryDelay: LOCK_RETRY_DELAY,
                });

                claimedSignal = await redlock.using([`signal:${signalId}:claim`], LOCK_TTL_MS, async () => {
                    // Double-check within lock — another process may have claimed
                    const existing = await Signal.findOne({ _id: signalId, status: 'CLAIMED' });
                    if (existing) {
                        throw new Error('Signal already claimed');
                    }

                    const signal = await Signal.findOneAndUpdate(
                        { _id: signalId, status: 'PENDING' },
                        {
                            status: 'CLAIMED',
                            assignedAgent: agentId,
                            assignedAt: new Date()
                        },
                        { new: true }
                    );

                    return signal;
                });

                if (!claimedSignal) {
                    console.log(`⚠️ [SWARM] Signal ${signalId} already claimed or not found (Redlock path)`);
                    return null;
                }

                // Update agent workload (outside lock — no contention risk)
                await this._updateAgentWorkload(agentId, claimedSignal);
                console.log(`🤖 [SWARM] Agent ${agentId} claimed signal ${signalId} (${claimedSignal.type}) via Redlock`);

                // Fire & Forget execution
                const executor = getAgentExecutor(this);
                setImmediate(() => {
                    executor.executeSignal(claimedSignal._id, agentId).catch(err => {
                        console.error(`[EXECUTOR ERROR] ${claimedSignal._id}:`, err.message);
                    });
                });

                return claimedSignal;
            } catch (err) {
                if (err.message?.includes('already claimed') || err.message?.includes('locked')) {
                    console.log(`⚠️ [SWARM] Signal ${signalId} already claimed (Redlock path)`);
                    return null;
                }
                // Redlock failed — fall through to MongoDB atomic path
                console.warn(`[SWARM] Redlock failed for ${signalId}, falling back to MongoDB: ${err.message}`);
            }
        }

        // ── MongoDB atomic fallback: safe without Redis ───────────
        // findOneAndUpdate with status filter is atomic — prevents double-claim
        const signal = await Signal.findOneAndUpdate(
            { _id: signalId, status: 'PENDING' },
            {
                status: 'CLAIMED',
                assignedAgent: agentId,
                assignedAt: new Date()
            },
            { new: true }
        );

        if (!signal) {
            console.log(`⚠️ [SWARM] Signal ${signalId} already claimed or not found`);
            return null;
        }

        await this._updateAgentWorkload(agentId, signal);
        console.log(`🤖 [SWARM] Agent ${agentId} claimed signal ${signalId} (${signal.type}) via MongoDB atomic`);

        if (this.io) {
            this.io.to(signal.clientId).emit('signal:claimed', {
                id: signal._id,
                agentId,
                type: signal.type
            });
        }

        // Fire & Forget execution
        const executor = getAgentExecutor(this);
        setImmediate(() => {
            executor.executeSignal(signal._id, agentId).catch(err => {
                console.error(`[EXECUTOR ERROR] ${signal._id}:`, err.message);
            });
        });

        return signal;
    }

    /**
     * Resolve a Signal — mark as complete with audit trail.
     * Uses Redlock if Redis available to prevent concurrent resolve operations.
     */
    async resolveSignal(signalId, result, reasoning_path, confidence_score, redisClient = null) {
        const lockKey = `signal:${signalId}:resolve`;

        // ── Redlock path: prevent concurrent resolve ──────────────
        if (Redlock && redisClient) {
            try {
                const redlock = new Redlock([redisClient], {
                    driftFactor: 0.01,
                    retryCount: LOCK_RETRY_COUNT,
                    retryDelay: LOCK_RETRY_DELAY,
                });

                const signal = await redlock.using([lockKey], LOCK_TTL_MS, async () => {
                    return Signal.findOneAndUpdate(
                        { _id: signalId, status: 'CLAIMED' },
                        {
                            status: 'RESOLVED',
                            result,
                            reasoning_path,
                            confidence_score,
                            resolvedAt: new Date()
                        },
                        { new: true }
                    );
                });

                if (!signal) {
                    console.log(`⚠️ [SWARM] Signal ${signalId} not in CLAIMED state, cannot resolve`);
                    return null;
                }

                await this._updateAgentAfterResolve(signal.assignedAgent, signal._id, confidence_score);
                console.log(`✅ [SWARM] Signal ${signalId} resolved by ${signal.assignedAgent} (confidence: ${confidence_score}) via Redlock`);

                if (this.io) {
                    this.io.to(signal.clientId).emit('signal:resolved', {
                        id: signal._id,
                        agentId: signal.assignedAgent,
                        confidence_score
                    });
                }

                return signal;
            } catch (err) {
                if (err.message?.includes('locked')) {
                    console.warn(`[SWARM] Signal ${signalId} resolve already in progress`);
                    return null;
                }
                console.warn(`[SWARM] Redlock resolve failed for ${signalId}, falling back: ${err.message}`);
                // Fall through to MongoDB path
            }
        }

        // ── MongoDB atomic fallback ─────────────────────────────────
        const signal = await Signal.findOneAndUpdate(
            { _id: signalId, status: 'CLAIMED' },
            {
                status: 'RESOLVED',
                result,
                reasoning_path,
                confidence_score,
                resolvedAt: new Date()
            },
            { new: true }
        );

        if (!signal) {
            console.log(`⚠️ [SWARM] Signal ${signalId} not in CLAIMED state, cannot resolve`);
            return null;
        }

        await _updateAgentAfterResolve(signal.assignedAgent, signal._id, confidence_score);
        console.log(`✅ [SWARM] Signal ${signalId} resolved by ${signal.assignedAgent} (confidence: ${confidence_score}) via MongoDB atomic`);

        if (this.io) {
            this.io.to(signal.clientId).emit('signal:resolved', {
                id: signal._id,
                agentId: signal.assignedAgent,
                confidence_score
            });
        }

        return signal;
    }

    /**
     * Escalate a Signal — push to human dashboard.
     * Triggered when confidence < threshold or financial thresholds are hit.
     */
    async escalateSignal(signalId, reason) {
        const signal = await Signal.findOneAndUpdate(
            { _id: signalId },
            {
                status: 'ESCALATED',
                escalationReason: reason,
                escalatedAt: new Date()
            },
            { new: true }
        );

        if (!signal) return null;

        // Update agent escalation count
        if (signal.assignedAgent) {
            await AgentState.findOneAndUpdate(
                { agentId: signal.assignedAgent },
                {
                    $pull: { activeSignals: signal._id },
                    $inc: { totalEscalations: 1 },
                    $set: { status: 'IDLE' }
                }
            );
        }

        // Create a HUMAN_ESCALATION signal for the dashboard
        await Signal.create({
            clientId: signal.clientId,
            type: 'HUMAN_ESCALATION',
            payload: {
                originalSignal: signal._id,
                originalType: signal.type,
                reason,
                originalPayload: signal.payload
            },
            source: 'swarm_manager',
            priority: 1  // Highest priority
        });

        console.log(`🚨 [SWARM] Signal ${signalId} ESCALATED: ${reason}`);

        if (this.io) {
            this.io.to(signal.clientId).emit('signal:escalated', {
                id: signal._id,
                reason,
                originalType: signal.type,
                payload: signal.payload
            });
        }

        return signal;
    }

    /**
     * Decompose a Signal — CEO breaks a complex signal into sub-tasks.
     */
    async decomposeSignal(parentSignalId, childSignals) {
        const parent = await Signal.findById(parentSignalId);
        if (!parent) return [];

        const children = [];
        for (const child of childSignals) {
            const childSignal = await this.postSignal(
                child.type,
                child.payload,
                parent.clientId,
                {
                    source: 'ceo_decomposition',
                    parentSignalId: parent._id,
                    priority: child.priority || parent.priority
                }
            );
            children.push(childSignal);
        }

        // Link children to parent
        await Signal.findByIdAndUpdate(parentSignalId, {
            $push: { childSignals: { $each: children.map(c => c._id) } }
        });

        console.log(`🧩 [SWARM] Decomposed signal ${parentSignalId} into ${children.length} sub-signals`);
        return children;
    }

    /**
     * Scan the Blackboard — find all unresolved signals for a client.
     * Used by the CEO Heartbeat.
     */
    async scanBlackboard(clientId, options = {}) {
        const query = { 
            clientId, 
            status: { $in: options.statuses || ['PENDING'] }
        };

        if (options.olderThan) {
            query.createdAt = { $lt: new Date(Date.now() - options.olderThan) };
        }

        if (options.types) {
            query.type = { $in: options.types };
        }

        return Signal.find(query)
            .sort({ priority: 1, createdAt: 1 })
            .limit(options.limit || 50)
            .lean();
    }

    /**
     * Get agent states for a client — used by the Swarm Monitor UI.
     */
    async getSwarmStatus(clientId) {
        const agents = await AgentState.find({ clientId }).lean();
        const pendingSignals = await Signal.countDocuments({ clientId, status: 'PENDING' });
        const claimedSignals = await Signal.countDocuments({ clientId, status: 'CLAIMED' });
        const escalatedSignals = await Signal.countDocuments({ clientId, status: 'ESCALATED' });
        const recentResolved = await Signal.countDocuments({ 
            clientId, 
            status: 'RESOLVED',
            resolvedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });

        return {
            agents,
            signals: {
                pending: pendingSignals,
                claimed: claimedSignals,
                escalated: escalatedSignals,
                resolvedLast24h: recentResolved
            }
        };
    }

    /**
     * Initialize default agents for a new client.
     */
    async initializeSwarm(clientId) {
        const defaults = [
            {
                agentId: `${clientId}:CEO`,
                role: 'CEO',
                displayName: 'CEO — Strategy Lobe',
                contract: {
                    systemPrompt: 'You are the CEO Agent. Scan the Blackboard for unresolved signals, decompose complex ones, and assign them to specialized Worker Lobes. Prioritize by urgency and business impact.',
                    subscribedSignals: ['HEARTBEAT', 'SYSTEM_ALERT'],
                    maxConcurrency: 1,
                    confidenceThreshold: 0.9,
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.2
                }
            },
            {
                agentId: `${clientId}:SALES`,
                role: 'SALES',
                displayName: 'Sales — Revenue Lobe',
                contract: {
                    systemPrompt: 'You are the Sales Agent. Handle inbound messages from potential leads. Qualify them as HOT/WARM/COLD based on intent and engagement. Generate personalized responses in Hinglish.',
                    subscribedSignals: ['INBOUND_MESSAGE', 'LEAD_QUALIFIED'],
                    maxConcurrency: 3,
                    confidenceThreshold: 0.85,
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.4
                }
            },
            {
                agentId: `${clientId}:OPS`,
                role: 'OPS',
                displayName: 'Operations — Logistics Lobe',
                contract: {
                    systemPrompt: 'You are the Operations Agent. Handle shipping updates, content briefs, campaign coordination, and inventory management. Be precise and action-oriented.',
                    subscribedSignals: ['CAMPAIGN_EVENT', 'INVENTORY_LOW'],
                    maxConcurrency: 2,
                    confidenceThreshold: 0.8,
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.3
                }
            },
            {
                agentId: `${clientId}:FINANCE`,
                role: 'FINANCE',
                displayName: 'Finance — Treasury Lobe',
                contract: {
                    systemPrompt: 'You are the Finance Agent. Handle payment confirmations, invoice generation, and settlement tracking. CRITICAL: Any amount > ₹50,000 MUST be escalated to human review (Protocol 201.3).',
                    subscribedSignals: ['PAYMENT_PENDING'],
                    maxConcurrency: 1,
                    confidenceThreshold: 0.95,
                    financialThreshold: 50000,
                    model: 'llama-3.3-70b-versatile',
                    temperature: 0.1
                }
            }
        ];

        const agents = [];
        for (const def of defaults) {
            const existing = await AgentState.findOne({ agentId: def.agentId });
            if (!existing) {
                const agent = await AgentState.create({
                    clientId,
                    ...def
                });
                agents.push(agent);
                console.log(`🤖 [SWARM] Initialized agent: ${def.displayName}`);
            } else {
                agents.push(existing);
            }
        }

        return agents;
    }

    // ── Private helpers ──────────────────────────────────────

    /**
     * Auto-route: find an agent subscribed to this signal type and assign it.
     */
    async _autoRoute(signal) {
        // Don't auto-route escalations or heartbeats
        if (['HUMAN_ESCALATION', 'HEARTBEAT'].includes(signal.type)) return;

        const agent = await AgentState.findOne({
            clientId: signal.clientId,
            status: { $in: ['IDLE', 'ACTIVE'] },
            'contract.subscribedSignals': signal.type
        }).sort({ 'activeSignals': 1 });  // Prefer least-busy agent

        if (agent) {
            // Check if agent has capacity
            if (agent.activeSignals.length < agent.contract.maxConcurrency) {
                await this.claimSignal(signal._id, agent.agentId);
            }
        }
    }

    /**
     * Default priority mapping for signal types.
     */
    _getDefaultPriority(type) {
        const priorities = {
            'HUMAN_ESCALATION': 1,
            'PAYMENT_PENDING': 2,
            'INBOUND_MESSAGE': 3,
            'LEAD_QUALIFIED': 4,
            'INVENTORY_LOW': 5,
            'CAMPAIGN_EVENT': 6,
            'OUTBOUND_MESSAGE': 7,
            'SYSTEM_ALERT': 8,
            'HEARTBEAT': 9
        };
        return priorities[type] || 5;
    }

    // ── Private helpers ──────────────────────────────────────

    /**
     * Update agent's active workload after claiming a signal.
     * Extracted to a helper so Redlock path can reuse it.
     */
    async _updateAgentWorkload(agentId, signal) {
        await AgentState.findOneAndUpdate(
            { agentId },
            {
                $addToSet: { activeSignals: signal._id },
                $set: { status: 'ACTIVE', lastHeartbeat: new Date() }
            }
        );

        if (this.io) {
            this.io.to(signal.clientId).emit('signal:claimed', {
                id: signal._id,
                agentId,
                type: signal.type
            });
        }

        // Fire & Forget execution
        const executor = getAgentExecutor(this);
        setImmediate(() => {
            executor.executeSignal(signal._id, agentId).catch(err => {
                console.error(`[EXECUTOR ERROR] ${signal._id}:`, err.message);
            });
        });
    }

    /**
     * Update agent metrics after resolving a signal.
     * Extracted to a helper so Redlock path can reuse it.
     */
    async _updateAgentAfterResolve(agentId, signalId, confidence_score) {
        // Update agent: remove from active, increment count, set idle
        await AgentState.findOneAndUpdate(
            { agentId },
            {
                $pull: { activeSignals: signalId },
                $inc: { totalSignalsProcessed: 1 },
                $set: { status: 'IDLE' }
            }
        );

        // Update running average confidence
        const agent = await AgentState.findOne({ agentId });
        if (agent && confidence_score !== undefined) {
            const total = agent.totalSignalsProcessed;
            const newAvg = ((agent.avgConfidenceScore * (total - 1)) + confidence_score) / total;
            await AgentState.findOneAndUpdate(
                { agentId },
                { $set: { avgConfidenceScore: Math.round(newAvg * 1000) / 1000 } }
            );
        }
    }
}

// Singleton
let _instance = null;
function getSwarmManager(io) {
    if (!_instance) {
        _instance = new SwarmManager(io);
    } else if (io && !_instance.io) {
        _instance.io = io;
    }
    return _instance;
}

module.exports = { SwarmManager, getSwarmManager };
