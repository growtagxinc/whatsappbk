const mongoose = require('mongoose');

/**
 * AgentState — The Employment Record for a Cognitive Lobe
 * 
 * Each agent in the Swarm has a state document that defines:
 * - Its role (CEO, Sales, Ops, Finance, Custom)
 * - Its "Employment Contract" (system prompt + subscribed signals)
 * - Its PARA Memory (Projects, Areas, Resources, Archives)
 * - Health metrics (heartbeat, signal count, escalations)
 */

// PARA Memory sub-schemas
const ProjectSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'ON_HOLD', 'COMPLETED'], default: 'ACTIVE' },
    notes: String,
    deadline: Date,
    signalCount: { type: Number, default: 0 }
}, { _id: true, timestamps: true });

const AreaSchema = new mongoose.Schema({
    name: { type: String, required: true },
    responsibility: String,
    kpis: [{ metric: String, target: String, current: String }]
}, { _id: true });

const ResourceSchema = new mongoose.Schema({
    label: { type: String, required: true },
    content: String,
    contentType: { type: String, enum: ['text', 'url', 'json'], default: 'text' }
}, { _id: true });

const ArchiveSchema = new mongoose.Schema({
    label: { type: String, required: true },
    summary: String,
    archivedAt: { type: Date, default: Date.now },
    originalType: String  // 'project', 'area', 'resource'
}, { _id: true });

// Employment Contract — defines what the agent does and listens for
const ContractSchema = new mongoose.Schema({
    systemPrompt: { type: String, required: true },
    subscribedSignals: { 
        type: [String], 
        default: ['INBOUND_MESSAGE'],
        validate: {
            validator: function(v) {
                const valid = [
                    'INBOUND_MESSAGE', 'OUTBOUND_MESSAGE', 'LEAD_QUALIFIED',
                    'INVENTORY_LOW', 'PAYMENT_PENDING', 'HUMAN_ESCALATION',
                    'HEARTBEAT', 'CAMPAIGN_EVENT', 'SYSTEM_ALERT'
                ];
                return v.every(s => valid.includes(s));
            }
        }
    },
    maxConcurrency: { type: Number, default: 1 },
    confidenceThreshold: { type: Number, default: 0.85, min: 0, max: 1 },
    financialThreshold: { type: Number, default: 50000 },  // Protocol 201.3 in INR
    model: { type: String, default: 'llama-3.3-70b-versatile' },
    temperature: { type: Number, default: 0.4, min: 0, max: 1 }
}, { _id: false });

// Main AgentState Schema
const AgentStateSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    
    agentId: { 
        type: String, 
        required: true, 
        unique: true,
        // Format: {clientId}:{role} e.g., "usr_abc123:CEO"
    },
    
    role: { 
        type: String, 
        enum: ['CEO', 'SALES', 'OPS', 'FINANCE', 'CUSTOM'],
        required: true 
    },
    
    displayName: { type: String, default: 'Agent' },
    
    status: { 
        type: String, 
        enum: ['ACTIVE', 'IDLE', 'PAUSED', 'ERROR', 'INITIALIZING'], 
        default: 'IDLE' 
    },
    
    // Employment Contract — the agent's "job description"
    contract: { type: ContractSchema, required: true },
    
    // PARA Memory — per-agent institutional knowledge
    memory: {
        projects: [ProjectSchema],
        areas: [AreaSchema],
        resources: [ResourceSchema],
        archives: [ArchiveSchema]
    },
    
    // Health metrics
    lastHeartbeat: Date,
    totalSignalsProcessed: { type: Number, default: 0 },
    totalEscalations: { type: Number, default: 0 },
    totalErrors: { type: Number, default: 0 },
    avgConfidenceScore: { type: Number, default: 0 },
    
    // Current workload
    activeSignals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Signal' }],
    
    // Error tracking
    lastError: {
        message: String,
        timestamp: Date,
        signalId: mongoose.Schema.Types.ObjectId
    }
    
}, { timestamps: true });

// Compound indexes
AgentStateSchema.index({ clientId: 1, role: 1 });
AgentStateSchema.index({ status: 1, lastHeartbeat: 1 });

module.exports = mongoose.model('AgentState', AgentStateSchema);
