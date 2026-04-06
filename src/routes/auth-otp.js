const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const OTP = require('../../models/OTP');
const Session = require('../../models/Session');
const { issueToken } = require('../lib/auth');

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 300; // 5 minutes (matches MongoDB TTL index)
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 per minute per email+clientId
const rateLimitMap = new Map(); // {email+clientId: {count, resetAt}}

// ── Nodemailer transporter ────────────────────────────────────
function createTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

// ── OTP hash: SHA-256 of (code + email) with salt ───────────
function hashOTP(code, email) {
    const salt = process.env.OTP_SECRET || 'default-otp-salt';
    return crypto.createHash('sha256').update(`${code}:${email}:${salt}`).digest('hex');
}

// ── Generate 6-digit numeric OTP ─────────────────────────────
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Rate limit check ─────────────────────────────────────────
function checkRateLimit(email, clientId) {
    const key = `${email}:${clientId}`;
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    if (entry.count >= 1) return false; // 1 OTP per minute
    entry.count++;
    return true;
}

/**
 * POST /api/auth/send-otp
 * Generate and send an OTP to the given email address.
 * Associates the OTP with clientId for session linking.
 *
 * Body: { email: string, clientId?: string }
 */
router.post('/send-otp', async (req, res) => {
    const { email, clientId = 'default' } = req.body;

    if (!email || typeof email !== 'string') {
        return res.status(400).json({ error: 'email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Rate limit: 1 OTP per minute per email+clientId
    if (!checkRateLimit(normalizedEmail, clientId)) {
        return res.status(429).json({
            error: 'Too many requests. Please wait before requesting another OTP.',
            retryAfterSeconds: 60
        });
    }

    try {
        // Delete any existing OTPs for this email+clientId
        await OTP.deleteExisting(normalizedEmail, clientId);

        const code = generateCode();
        const hashedCode = hashOTP(code, normalizedEmail);

        await OTP.create({
            email: normalizedEmail,
            clientId,
            code: hashedCode,
            attempts: 0
        });

        // Send OTP via email
        const transporter = createTransporter();
        await transporter.sendMail({
            from: process.env.SMTP_FROM || '"Concertos" <noreply@concertos.brandproinc.in>',
            to: normalizedEmail,
            subject: 'Your Concertos OTP Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
                    <h2 style="color: #25D366;">Concertos — Email Verification</h2>
                    <p>Your one-time verification code is:</p>
                    <div style="background: #f4f4f4; border-radius: 8px; padding: 16px 24px; font-size: 32px; letter-spacing: 8px; font-weight: bold; text-align: center; color: #333; margin: 24px 0;">
                        ${code}
                    </div>
                    <p style="color: #666; font-size: 14px;">This code expires in <strong>5 minutes</strong>. Do not share it with anyone.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
                    <p style="color: #999; font-size: 12px;">If you didn't request this code, you can safely ignore this email.</p>
                </div>
            `,
            text: `Your Concertos OTP is: ${code}. It expires in 5 minutes.`
        });

        console.log(`[OTP] Sent to ${normalizedEmail} for clientId=${clientId}`);
        res.json({ success: true, message: 'OTP sent successfully', expiresInSeconds: OTP_TTL_SECONDS });
    } catch (err) {
        console.error('[OTP] Send error:', err.message);
        // Don't expose internal errors to client
        if (err.message.includes('Invalid login') || err.message.includes('Authentication')) {
            return res.status(503).json({ error: 'Email service not configured. Please contact support.' });
        }
        res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }
});

/**
 * POST /api/auth/verify-otp
 * Verify the OTP code and issue a JWT session token.
 *
 * Body: { email: string, code: string, clientId?: string }
 */
router.post('/verify-otp', async (req, res) => {
    const { email, code, clientId = 'default' } = req.body;

    if (!email || !code) {
        return res.status(400).json({ error: 'email and code are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const trimmedCode = (code || '').trim();

    try {
        const otpRecord = await OTP.findOne({
            email: normalizedEmail,
            clientId,
            verified: false
        }).sort({ createdAt: -1 });

        if (!otpRecord) {
            return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
        }

        // Increment attempt counter
        otpRecord.attempts += 1;

        if (otpRecord.attempts > MAX_ATTEMPTS) {
            await OTP.deleteOne({ _id: otpRecord._id });
            return res.status(400).json({ error: 'Too many failed attempts. Please request a new OTP.' });
        }

        const hashedInput = hashOTP(trimmedCode, normalizedEmail);
        if (hashedInput !== otpRecord.code) {
            await otpRecord.save();
            return res.status(400).json({
                error: 'Incorrect OTP code.',
                attemptsRemaining: MAX_ATTEMPTS - otpRecord.attempts
            });
        }

        // OTP is valid — mark as verified
        otpRecord.verified = true;
        await otpRecord.save();

        // Upsert the Session record: link email to this clientId
        const session = await Session.findOneAndUpdate(
            { clientId },
            {
                email: normalizedEmail,
                status: 'EMAIL_VERIFIED',
                authenticated: true
            },
            { upsert: true, new: true }
        );

        // Issue JWT token for this clientId
        const token = issueToken(clientId);

        console.log(`[OTP] Verified ${normalizedEmail} for clientId=${clientId}`);
        res.json({
            success: true,
            message: 'Email verified successfully',
            token,
            clientId,
            email: normalizedEmail
        });
    } catch (err) {
        console.error('[OTP] Verify error:', err.message);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

module.exports = router;
