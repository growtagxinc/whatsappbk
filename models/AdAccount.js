const mongoose = require('mongoose');

const AdAccountSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    platform: { type: String, enum: ['meta', 'google'], required: true },
    accountId: { type: String, required: true },
    accountName: { type: String, default: '' },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    status: { type: String, enum: ['active', 'expired', 'disconnected'], default: 'active' }
}, { timestamps: true });

AdAccountSchema.index({ workspaceId: 1, platform: 1 }, { unique: true });

const CampaignSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    platform: { type: String, enum: ['meta', 'google'], required: true },
    campaignId: { type: String, required: true },
    name: { type: String, required: true },
    status: { type: String, default: 'Active' },
    spend: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    leads: { type: Number, default: 0 },
    cpl: { type: Number, default: 0 },
    lastFetched: { type: Date, default: Date.now }
}, { timestamps: true });

CampaignSchema.index({ workspaceId: 1, platform: 1 });

const AdAccount = mongoose.model('AdAccount', AdAccountSchema);
const Campaign = mongoose.model('Campaign', CampaignSchema);

module.exports = { AdAccount, Campaign };
