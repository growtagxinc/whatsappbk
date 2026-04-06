const mongoose = require('mongoose');

const NotificationPrefSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, unique: true, index: true },
    orgId: { type: String, index: true },
    emailAlerts: { type: Boolean, default: true },
    whatsappAlerts: { type: Boolean, default: true },
    notifyOn: [{
        type: String,
        enum: ['new_lead', 'ticket_open', 'low_stock', 'payment_pending', 'booking_request', 'order_created', 'task_assigned']
    }]
}, { timestamps: true });

NotificationPrefSchema.index({ workspaceId: 1 });

const SecuritySettingSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, unique: true, index: true },
    orgId: { type: String, index: true },
    twoFactorEnabled: { type: Boolean, default: false },
    sessionTimeout: { type: Number, default: 30 }, // minutes
    ipWhitelist: [{ type: String }]
}, { timestamps: true });

SecuritySettingSchema.index({ workspaceId: 1 });

const NotificationPref = mongoose.model('NotificationPref', NotificationPrefSchema);
const SecuritySetting = mongoose.model('SecuritySetting', SecuritySettingSchema);

module.exports = { NotificationPref, SecuritySetting };
