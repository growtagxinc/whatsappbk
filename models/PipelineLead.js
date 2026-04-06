const mongoose = require('mongoose');

const PipelineLeadSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    leadId: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    source: { type: String, default: 'WhatsApp' }, // WhatsApp, IndiaMart, GoogleAds, Referral, Prospecting, Community
    value: { type: String, default: '' },
    stage: {
        type: String,
        enum: ['fresh', 'qualified', 'proposal', 'won', 'lost'],
        default: 'fresh'
    },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    notes: { type: String, default: '' },
    stageChangedAt: { type: Date, default: Date.now }
}, { timestamps: true });

PipelineLeadSchema.index({ workspaceId: 1, stage: 1 });
PipelineLeadSchema.index({ workspaceId: 1, status: 1 });

module.exports = mongoose.model('PipelineLead', PipelineLeadSchema);
