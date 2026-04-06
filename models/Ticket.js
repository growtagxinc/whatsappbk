const mongoose = require('mongoose');

const TicketSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true, index: true },
    clientId: { type: String, required: true, index: true },
    chatId: { type: String, required: true },
    customerName: { type: String, required: true },
    title: { type: String, required: true },
    description: String,
    status: { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open' },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    assignedTo: String
}, { timestamps: true });

module.exports = mongoose.model('Ticket', TicketSchema);
