const mongoose = require('mongoose');

const LessonSchema = new mongoose.Schema({
    lessonId: String,
    title: String,
    type: { type: String, enum: ['video', 'text'], default: 'text' },
    content: String,   // URL for video, HTML/text for text lessons
    duration: String, // e.g. "5 min"
    order: Number
});

const CourseSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    courseId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    thumbnail: { type: String, default: '' },
    category: { type: String, default: 'General' },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    enrolledCount: { type: Number, default: 0 },
    lessons: [LessonSchema]
}, { timestamps: true });

CourseSchema.index({ workspaceId: 1, status: 1 });

const EnrollmentSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    orgId: { type: String, index: true },
    enrollmentId: { type: String, required: true, unique: true },
    courseId: { type: String, required: true, index: true },
    studentName: { type: String, default: '' },
    studentPhone: { type: String, default: '' },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    enrolledAt: { type: Date, default: Date.now },
    completedAt: { type: Date }
}, { timestamps: true });

EnrollmentSchema.index({ workspaceId: 1, courseId: 1 });

const Course = mongoose.model('Course', CourseSchema);
const Enrollment = mongoose.model('Enrollment', EnrollmentSchema);

module.exports = { Course, Enrollment };
