const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    taskId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    priority: {
        type: String,
        enum: ['Critical', 'High', 'Medium', 'Low'],
        default: 'Medium'
    },
    status: {
        type: String,
        enum: ['todo', 'in_progress', 'review', 'completed'],
        default: 'todo'
    },
    assigneeId: { type: String, required: true },
    assigneeName: { type: String, default: '' },
    dueDate: { type: Date },
    vertical: { type: String, default: 'General' },
    createdBy: { type: String, default: '' }
}, { timestamps: true });

TaskSchema.index({ workspaceId: 1, assigneeId: 1 });
TaskSchema.index({ workspaceId: 1, status: 1 });
TaskSchema.index({ workspaceId: 1, dueDate: 1 });

module.exports = mongoose.model('Task', TaskSchema);
