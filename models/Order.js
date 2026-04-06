const mongoose = require('mongoose');

const OrderSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    orderId: { type: String, required: true, unique: true },
    customerName: { type: String, required: true },
    company: { type: String, default: '' },
    phone: { type: String, default: '' },
    items: [{
        name: String,
        qty: { type: Number, default: 1 },
        price: { type: Number, default: 0 }
    }],
    totalAmount: { type: Number, default: 0 },
    stage: {
        type: String,
        enum: ['draft', 'processing', 'dispatched', 'delivered'],
        default: 'draft'
    },
    notes: { type: String, default: '' }
}, { timestamps: true });

// Compute totalAmount from items before saving
OrderSchema.pre('save', function (next) {
    this.totalAmount = this.items.reduce((sum, item) => sum + (item.qty * item.price), 0);
    next();
});

OrderSchema.index({ workspaceId: 1, stage: 1 });
OrderSchema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
