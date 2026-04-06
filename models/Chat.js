const mongoose = require('mongoose');

/**
 * Chat — WhatsApp conversation metadata
 * Persisted in MongoDB so chat history survives WhatsApp Web restarts.
 * Updated on every inbound/outbound message.
 */
const ChatSchema = new mongoose.Schema({
    clientId:   { type: String, required: true, index: true },
    chatId:    { type: String, required: true, unique: true }, // `${clientId}:${wid}`
    wid:       { type: String, required: true, index: true },   // WhatsApp contact ID
    name:      { type: String, default: '' },
    type:      { type: String, default: 'chat' }, // 'chat' | 'group'
    unread:    { type: Number, default: 0 },
    lastMessage:     { type: String, default: '' },
    lastMessageId:   { type: String, default: '' },
    lastInteraction: { type: Number, default: 0 }, // unix timestamp (seconds)
    isActive:  { type: Boolean, default: true },
}, { timestamps: true });

ChatSchema.index({ clientId: 1, lastInteraction: -1 });

module.exports = mongoose.model('Chat', ChatSchema);
