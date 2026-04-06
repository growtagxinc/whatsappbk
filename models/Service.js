const mongoose = require('mongoose');

const ServiceSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    serviceId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    duration: { type: String, default: '30 min' },   // e.g. "30 min", "1 hour"
    price: { type: Number, default: 0 },
    category: { type: String, default: 'General' },
    location: { type: String, default: 'Online' },
    color: { type: String, default: '#E85D04' },
    visibility: { type: String, enum: ['Public', 'Private'], default: 'Public' }
}, { timestamps: true });

ServiceSchema.index({ workspaceId: 1, visibility: 1 });

module.exports = mongoose.model('Service', ServiceSchema);
