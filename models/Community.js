const mongoose = require('mongoose');

const CommunitySchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    communityId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    platform: { type: String, enum: ['WhatsApp', 'Telegram', 'Facebook', 'Other'], default: 'WhatsApp' },
    memberCount: { type: Number, default: 0 },
    link: { type: String, default: '' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' }
}, { timestamps: true });

const CommunityMemberSchema = new mongoose.Schema({
    communityId: { type: String, required: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    memberId: { type: String, required: true },
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    joinedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Community = mongoose.model('Community', CommunitySchema);
const CommunityMember = mongoose.model('CommunityMember', CommunityMemberSchema);

module.exports = { Community, CommunityMember };
