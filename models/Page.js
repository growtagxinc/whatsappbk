const mongoose = require('mongoose');

const BlockSchema = new mongoose.Schema({
    type: { type: String, required: true }, // heading, subheading, paragraph, cta_button, form, image, divider
    content: mongoose.Schema.Types.Mixed,    // flexible per block type
    order: { type: Number, default: 0 }
});

const PageSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    pageId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    type: { type: String, enum: ['landing', 'funnel'], default: 'landing' },
    blocks: [BlockSchema],
    status: { type: String, enum: ['draft', 'live'], default: 'draft' },
    visits: { type: Number, default: 0 },
    conversions: { type: Number, default: 0 },
    whatsappNumber: { type: String, default: '' }
}, { timestamps: true });

PageSchema.index({ workspaceId: 1, status: 1 });

const FunnelSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    funnelId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    steps: [{ pageId: String, order: Number }],
    status: { type: String, enum: ['draft', 'live'], default: 'draft' }
}, { timestamps: true });

const Page = mongoose.model('Page', PageSchema);
const Funnel = mongoose.model('Funnel', FunnelSchema);

module.exports = { Page, Funnel };
