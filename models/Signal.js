const mongoose = require('mongoose');

/**
 * Signal — The Blackboard Event Schema
 * 
 * A Signal is a reactive event posted to the Blackboard.
 * Agents "subscribe" to signal types based on their Employment Contract.
 * Signals flow: PENDING → CLAIMED → RESOLVED (or ESCALATED)
 */
const SignalSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    
    type: { 
        type: String, 
        enum: [
            'INBOUND_MESSAGE',      // WhatsApp/Meta message received
            'OUTBOUND_MESSAGE',     // Agent sent a reply
            'LEAD_QUALIFIED',       // AI scored a lead
            'INVENTORY_LOW',        // Stock below threshold
            'ORDER_CREATED',        // New order placed
            'BOOKING_REQUEST',      // Appointment slot requested
            'BOOKING_CONFIRMED',    // Appointment confirmed
            'PAYMENT_PENDING',      // Protocol 201.3 trigger
            'HUMAN_ESCALATION',     // Confidence < 0.85
            'HEARTBEAT',            // CEO pulse scan
            'CAMPAIGN_EVENT',       // Marketing automation
            'SYSTEM_ALERT'          // Internal system event
        ],
        required: true 
    },
    
    status: { 
        type: String, 
        enum: ['PENDING', 'CLAIMED', 'RESOLVED', 'ESCALATED', 'EXPIRED'], 
        default: 'PENDING',
        index: true
    },
    
    // Raw event data — flexible structure per signal type
    payload: mongoose.Schema.Types.Mixed,
    
    // Origin tracking
    source: { type: String, default: 'system' },  // 'whatsapp', 'meta_webhook', 'system', 'heartbeat'
    sourceId: String,                               // Original message ID / event ID
    
    // Agent assignment
    assignedAgent: String,                          // Which lobe claimed it
    assignedAt: Date,
    
    // Audit trail — every action must have reasoning
    reasoning_path: String,                         // Why the agent took this action
    confidence_score: { type: Number, min: 0, max: 1 },  // 0.0 - 1.0
    
    // Resolution
    result: mongoose.Schema.Types.Mixed,            // What the agent produced
    resolvedAt: Date,
    
    // Decomposition chain — CEO can break signals into sub-signals
    parentSignalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Signal' },
    childSignals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Signal' }],
    
    // Priority for queue ordering
    priority: { type: Number, default: 5, min: 1, max: 10 },  // 1=critical, 10=background
    
    // Escalation tracking
    escalationReason: String,
    escalatedAt: Date
    
}, { timestamps: true });

// Compound indexes for efficient Blackboard scanning
SignalSchema.index({ clientId: 1, status: 1, type: 1 });
SignalSchema.index({ clientId: 1, status: 1, priority: 1, createdAt: 1 });
SignalSchema.index({ assignedAgent: 1, status: 1 });

// TTL: Auto-expire signals after 7 days to prevent DB bloat
SignalSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('Signal', SignalSchema);
