const mongoose = require('mongoose');

const EmployeeSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    employeeId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    role: { type: String, default: '' },
    dept: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    location: { type: String, default: '' },
    status: { type: String, enum: ['active', 'on_leave', 'inactive'], default: 'active' }
}, { timestamps: true });

EmployeeSchema.index({ workspaceId: 1, status: 1 });

const AttendanceSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    employeeId: { type: String, required: true, index: true },
    date: { type: Date, required: true },
    clockIn: { type: String },
    clockOut: { type: String },
    status: { type: String, enum: ['present', 'absent', 'late'], default: 'present' }
}, { timestamps: true });

AttendanceSchema.index({ workspaceId: 1, date: 1 });

const LeaveSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    leaveId: { type: String, required: true, unique: true },
    employeeId: { type: String, required: true, index: true },
    employeeName: { type: String, default: '' },
    type: { type: String, default: 'Sick Leave' },
    duration: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reason: { type: String, default: '' }
}, { timestamps: true });

LeaveSchema.index({ workspaceId: 1, status: 1 });

const Employee = mongoose.model('Employee', EmployeeSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);
const Leave = mongoose.model('Leave', LeaveSchema);

module.exports = { Employee, Attendance, Leave };
