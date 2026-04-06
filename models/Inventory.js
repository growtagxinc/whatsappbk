const mongoose = require('mongoose');

const InventorySchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    productId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    category: { type: String, default: 'General' },
    stock: { type: Number, default: 0 },
    minStock: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    unit: { type: String, default: 'pcs' },
    status: {
        type: String,
        enum: ['healthy', 'low', 'out'],
        default: 'healthy'
    }
}, { timestamps: true });

// Auto-compute status before save
InventorySchema.pre('save', function (next) {
    if (this.stock === 0) {
        this.status = 'out';
    } else if (this.stock < this.minStock) {
        this.status = 'low';
    } else {
        this.status = 'healthy';
    }
    next();
});

// Index for efficient workspace queries
InventorySchema.index({ workspaceId: 1, status: 1 });
InventorySchema.index({ workspaceId: 1, category: 1 });

module.exports = mongoose.model('Inventory', InventorySchema);
