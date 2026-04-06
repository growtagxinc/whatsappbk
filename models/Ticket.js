const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true, index: true },
    chatId: { type: String },
    customerName: { type: String },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    assignedTo: { type: String },
    assigneeName: { type: String },
    tags: { type: [String], default: [] },
    messages: [{
        id: { type: String, default: () => crypto.randomBytes(4).toString('hex') },
        author: { type: String },
        authorType: { type: String, enum: ['agent', 'customer', 'system'], default: 'agent' },
        content: { type: String },
        createdAt: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

module.exports = mongoose.model('Ticket', TicketSchema);
