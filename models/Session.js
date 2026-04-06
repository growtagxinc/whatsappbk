const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
    clientId: { type: String, required: true, unique: true, index: true },
    status: { type: String, default: 'DISCONNECTED' },
    qr: String,
    authenticated: { type: Boolean, default: false },
    email: { type: String, default: '' },
    displayName: { type: String, default: '' },
    bio: { type: String, default: '' },
    googleTokens: {
        access_token: String,
        refresh_token: String,
        scope: String,
        token_type: String,
        expiry_date: Number
    },
    googleEmail: String,
    lastActive: { type: Date, default: Date.now },

    // Onboarding Step 1: WhatsApp connection state
    whatsappConnected: { type: Boolean, default: false },
    whatsappWid: { type: String, default: '' }, // WhatsApp JID e.g. "9198178081629@c.us"
    connectionType: { type: String, default: null }, // 'qr', 'email_otp', 'meta_cloud'
    connectionMethod: { type: String, default: null }, // alias for connectionType

    // Onboarding progress tracker
    onboardingStep: { type: Number, default: 0 }, // 0=not started, 1=whatsapp connected, 2=gmail linked, 3=business info saved

    // Onboarding business info (Step 3)
    businessName: { type: String, default: '' },
    businessDescription: { type: String, default: '' },
    businessWebsite: { type: String, default: '' },

    // ── Convenience mirrors of canonical User/Org/Workspace fields ──
    // Canonical: User.phone
    phone: { type: String, default: '' },
    // Canonical: Organisation.name
    company: { type: String, default: '' },
    // Canonical: Workspace.sector
    sector: { type: String, default: '' },
    // Canonical: Workspace.vertical
    vertical: { type: String, default: '' },
    // Canonical: Workspace.name
    workspaceName: { type: String, default: '' },

    // ── Multi-tenant migration fields ──────────────────────
    // Populated by lazy migration when existing users log in
    orgId: { type: String, default: null, index: true },
    workspaceId: { type: String, default: null, index: true },
}, { timestamps: true });

module.exports = mongoose.model('Session', SessionSchema);
