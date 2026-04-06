const mongoose = require('mongoose');

const ProspectSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    prospectId: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    source: { type: String, default: 'Cold Outreach' },
    score: { type: Number, default: 50, min: 0, max: 100 },
    status: {
        type: String,
        enum: ['new', 'contacted', 'qualified', 'converted'],
        default: 'new'
    },
    notes: { type: String, default: '' }
}, { timestamps: true });

ProspectSchema.index({ workspaceId: 1, status: 1 });
ProspectSchema.index({ workspaceId: 1, score: -1 });

module.exports = mongoose.model('Prospect', ProspectSchema);
