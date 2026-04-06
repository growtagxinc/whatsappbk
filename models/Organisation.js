const mongoose = require('mongoose');

const OrganisationSchema = new mongoose.Schema({
    orgId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    plan: {
        type: String,
        enum: ['trial', 'pro', 'enterprise'],
        default: 'trial',
    },
    trialEndsAt: {
        type: Date,
        default: () => {
            const d = new Date();
            d.setDate(d.getDate() + 14);
            return d;
        },
    },
    razorpayCustomerId: {
        type: String,
        default: null,
    },
    razorpaySubscriptionId: {
        type: String,
        default: null,
    },
}, { timestamps: true });

OrganisationSchema.index({ name: 'text' });

module.exports = mongoose.model('Organisation', OrganisationSchema);
