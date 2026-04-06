const mongoose = require('mongoose');

const aiAgentSchema = new mongoose.Schema({
    label: { type: String, required: true }, // e.g., "FAQ Assistant", "Sales Agent"
    prompt: { type: String, default: '' },
    isActive: { type: Boolean, default: false }
});

const aiConfigSchema = new mongoose.Schema({
    clientId: { type: String, required: true, unique: true },
    
    // Master toggle — AI will NOT auto-reply unless this is true
    aiEnabled: { type: Boolean, default: false },
    
    // Business context for the AI
    businessName: { type: String, default: 'My Business' },
    businessDescription: { type: String, default: '' },
    businessWebsite: { type: String, default: '' },
    language: { type: String, default: 'en' }, // 'en', 'hi', 'hinglish'
    sector: { type: String, default: '' },
    vertical: { type: String, default: '' },

    // Per-client Meta WABA Credentials (Pro Tier)
    metaToken: { type: String, default: '' },
    metaPhoneNumberId: { type: String, default: '' },

    // ── Multi-tenant migration fields ──────────────────────
    orgId: { type: String, default: null, index: true },
    workspaceId: { type: String, default: null, index: true },

    // Per-agent configs
    agents: {
        faq: { type: aiAgentSchema, default: () => ({ label: 'FAQ Assistant', prompt: 'You are a helpful FAQ assistant.', isActive: false }) },
        sales: { type: aiAgentSchema, default: () => ({ label: 'Sales Agent', prompt: 'You are a sales assistant.', isActive: false }) },
        vision: { type: aiAgentSchema, default: () => ({ label: 'Visual Analyst', prompt: 'You analyze images.', isActive: false }) },
        custom: { type: aiAgentSchema, default: () => ({ label: 'Custom Agent', prompt: 'You are a custom assistant.', isActive: false }) }
    }
}, { timestamps: true });

module.exports = mongoose.model('AIConfig', aiConfigSchema);
