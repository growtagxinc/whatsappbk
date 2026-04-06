const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, trim: true },
    clientId: { type: String, required: true, index: true },
    code: { type: String, required: true }, // hashed
    attempts: { type: Number, default: 0 },
    verified: { type: Boolean, default: false }
}, { timestamps: true });

// TTL index: automatically expire documents after 5 minutes
OTPSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

// Index for fast lookup by email+clientId
OTPSchema.index({ email: 1, clientId: 1 });

// Remove old OTPs for same email+clientId before creating new one
OTPSchema.statics.deleteExisting = async function(email, clientId) {
    await this.deleteMany({ email: email.toLowerCase(), clientId });
};

module.exports = mongoose.model('OTP', OTPSchema);
