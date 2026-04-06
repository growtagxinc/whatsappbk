const mongoose = require('mongoose');

const AppointmentSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    appointmentId: { type: String, required: true, unique: true },
    serviceId: { type: String, required: true },
    serviceName: { type: String, default: '' },
    customerName: { type: String, required: true },
    phone: { type: String, default: '' },
    date: { type: Date, required: true, index: true },
    timeSlot: { type: String, required: true },  // e.g. "10:00 AM"
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'cancelled'],
        default: 'pending'
    },
    amount: { type: Number, default: 0 },
    notes: { type: String, default: '' }
}, { timestamps: true });

AppointmentSchema.index({ workspaceId: 1, date: 1, status: 1 });
AppointmentSchema.index({ workspaceId: 1, phone: 1 });

module.exports = mongoose.model('Appointment', AppointmentSchema);
