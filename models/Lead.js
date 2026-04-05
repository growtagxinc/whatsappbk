const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
    clientId: { type: String, required: true, index: true },
    name: String,
    phone: { type: String, required: true },
    resolvedNumber: String,
    email: String,
    inquiry: String,
    qualification: { type: String, enum: ['HOT', 'WARM', 'COLD', 'UNKNOWN'], default: 'UNKNOWN' },
    reason: String,
    status: { type: String, enum: ['NEW', 'QUALIFIED', 'BOOKED', 'PAID', 'LOST'], default: 'NEW' },
    notes: String,
    privateNotes: [{
        author: String,
        text: String,
        timestamp: { type: Date, default: Date.now }
    }],
    tags: [String],
    customProperties: [{
        label: String,
        value: String
    }],
    source: { type: String, default: 'WhatsApp CRM' },
    presence: String, // Online/Offline/Last Seen
    assignedAgent: { type: String, default: 'AI_BOT' }, // AI_BOT or HUMAN_AGENT
    isAiPaused: { type: Boolean, default: false },
    lastInteraction: { type: Date, default: Date.now },
    auditData: Object,
    lastAuditedAt: Date,
    conversation: [{
        role: { type: String, enum: ['user', 'ai', 'system'] },
        content: String,
        timestamp: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

// Ensure a user only sees their own version of a contact
LeadSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.model('Lead', LeadSchema);

