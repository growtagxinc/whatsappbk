const mongoose = require('mongoose');

const WorkspaceSchema = new mongoose.Schema({
    workspaceId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    orgId: {
        type: String,
        required: true,
        index: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    sector: {
        type: String,
        default: '',
    },
    vertical: {
        type: String,
        default: '',
    },
    modules: {
        type: [String],
        default: ['dashboard', 'chats', 'tickets'],
    },
    language: {
        type: String,
        default: 'en',
    },
    aiEnabled: {
        type: Boolean,
        default: true,
    },
    agents: {
        faq: {
            label: String,
            prompt: String,
            isActive: { type: Boolean, default: false },
        },
        sales: {
            label: String,
            prompt: String,
            isActive: { type: Boolean, default: false },
        },
        vision: {
            label: String,
            prompt: String,
            isActive: { type: Boolean, default: false },
        },
        custom: {
            label: String,
            prompt: String,
            isActive: { type: Boolean, default: false },
        },
    },
    // Which WhatsApp number (owned by org) is assigned to this workspace
    whatsappNumberId: {
        type: String,
        default: null,
    },
    // Legacy: was the original clientId that this workspace maps to
    legacyClientId: {
        type: String,
        default: null,
        index: true,
    },
}, { timestamps: true });

WorkspaceSchema.index({ orgId: 1, name: 'text' });

module.exports = mongoose.model('Workspace', WorkspaceSchema);
