const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    clientId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true,
    },
    password: {
        type: String,
        required: true, // bcrypt hashed
    },
    phone: {
        type: String,
        default: '',
        trim: true,
    },
    displayName: {
        type: String,
        default: '',
        trim: true,
    },
    // Auth method tracking
    authMethods: {
        type: [String],
        default: [], // e.g. ['password', 'google']
    },
    // Google OAuth data (if linked)
    googleId: {
        type: String,
        default: null,
    },
    googleTokens: {
        access_token: String,
        refresh_token: String,
        scope: String,
        token_type: String,
        expiry_date: Number,
    },
    googleEmail: {
        type: String,
        default: null,
    },
    // Last login
    lastLogin: {
        type: Date,
        default: null,
    },
    // Soft delete
    isActive: {
        type: Boolean,
        default: true,
    },

    // ── Multi-tenant ──────────────────────────────────────
    // Primary org this user belongs to (quick lookup for login)
    primaryOrgId: {
        type: String,
        default: null,
        index: true,
    },
}, { timestamps: true });

// Index for fast lookups
UserSchema.index({ email: 1 });
UserSchema.index({ googleId: 1 });

module.exports = mongoose.model('User', UserSchema);
