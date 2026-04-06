const mongoose = require('mongoose');

const OrgMemberSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true,
    },
    orgId: {
        type: String,
        required: true,
        index: true,
    },
    role: {
        type: String,
        enum: ['owner', 'admin', 'member'],
        default: 'member',
    },
    joinedAt: {
        type: Date,
        default: Date.now,
    },
    invitedBy: {
        type: String,
        default: null,
    },
    isSuperAdmin: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true });

// One user can be member of many orgs; one org can have many members
OrgMemberSchema.index({ userId: 1, orgId: 1 }, { unique: true });
OrgMemberSchema.index({ orgId: 1 });

module.exports = mongoose.model('OrgMember', OrgMemberSchema);
