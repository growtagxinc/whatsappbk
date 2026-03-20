const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
    name: String,
    phone: { type: String, required: true, unique: true },
    email: String,
    inquiry: String,
    qualification: { type: String, enum: ['HOT', 'WARM', 'COLD', 'UNKNOWN'], default: 'UNKNOWN' },
    reason: String,
    status: { type: String, enum: ['NEW', 'QUALIFIED', 'BOOKED', 'PAID', 'LOST'], default: 'NEW' },
    notes: String,
    source: { type: String, default: 'IndiaMart' },
    lastInteraction: { type: Date, default: Date.now },
    conversation: [{
        role: { type: String, enum: ['user', 'ai', 'system'] },
        content: String,
        timestamp: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Lead', LeadSchema);
