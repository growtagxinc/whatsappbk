const mongoose = require('mongoose');

const InvoiceSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    invoiceId: { type: String, required: true, unique: true },
    customerName: { type: String, required: true },
    phone: { type: String, default: '' },
    items: [{
        name: String,
        qty: { type: Number, default: 1 },
        price: { type: Number, default: 0 }
    }],
    subtotal: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    status: {
        type: String,
        enum: ['draft', 'sent', 'paid', 'overdue'],
        default: 'draft'
    },
    dueDate: { type: Date }
}, { timestamps: true });

InvoiceSchema.pre('save', function (next) {
    this.subtotal = this.items.reduce((s, i) => s + (i.qty * i.price), 0);
    this.gstAmount = Math.round(this.subtotal * 0.18);
    this.totalAmount = this.subtotal + this.gstAmount;
    next();
});

InvoiceSchema.index({ workspaceId: 1, status: 1 });
InvoiceSchema.index({ workspaceId: 1, createdAt: -1 });

const TransactionSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    transactionId: { type: String, required: true, unique: true },
    clientName: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    status: { type: String, enum: ['Succeeded', 'Pending', 'Failed'], default: 'Succeeded' },
    type: { type: String, enum: ['Invoice', 'Subscription', 'One-time'], default: 'Invoice' }
}, { timestamps: true });

TransactionSchema.index({ workspaceId: 1, createdAt: -1 });

const Invoice = mongoose.model('Invoice', InvoiceSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

module.exports = { Invoice, Transaction };
