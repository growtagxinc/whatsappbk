/**
 * Shared Zod validation schemas — ESM version
 *
 * Single source of truth for request validation.
 * Use this in ESM contexts (tests, new modules with "type": "module").
 * Route files continue using the CJS version via require().
 *
 * Usage (ESM):
 *   import { registerSchema, loginSchema } from './validation-schemas.mjs';
 */

import { z } from 'zod';

const phoneRegex = /^\+91[6-9]\d{9}$/;

// ─── Auth Schemas ────────────────────────────────────────────────

const registerSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .max(128, 'Password too long'),
    displayName: z.string().min(1, 'Display name is required').max(100),
    phone: z.string().regex(phoneRegex, 'Phone must be +91 followed by 10 digits'),
    orgName: z.string().min(2, 'Organization name too short').max(100),
});

const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
});

const updateProfileSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    phone: z.string().regex(phoneRegex).optional(),
});

const passwordResetRequestSchema = z.object({
    email: z.string().email('Invalid email address'),
});

const passwordResetSchema = z.object({
    token: z.string().min(1, 'Token is required'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

// ─── Onboarding Schemas ──────────────────────────────────────────

const onboardingStep1Schema = z.object({
    workspaceName: z.string().min(2).max(100),
    phone: z.string().regex(phoneRegex),
    businessName: z.string().min(1).max(200).optional(),
});

const onboardingStep2Schema = z.object({
    agentName: z.string().min(1).max(50),
    dailySummary: z.boolean().optional(),
});

const onboardingStep3Schema = z.object({
    sector: z.enum(['fashion', 'food', 'services', 'tech', 'education', 'health', 'other']),
    vertical: z.string().min(1).max(100),
    modules: z.array(z.string()).min(1, 'Select at least one module'),
});

const setPasswordSchema = z.object({
    password: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .max(128, 'Password too long'),
});

// ─── CRM Schemas ─────────────────────────────────────────────────

const createLeadSchema = z.object({
    name: z.string().min(1).max(200),
    phone: z.string().regex(phoneRegex, 'Invalid phone number'),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    qualification: z.enum(['HOT', 'WARM', 'COLD', 'UNKNOWN']).optional(),
    status: z.enum(['NEW', 'QUALIFIED', 'BOOKED', 'PAID', 'LOST']).optional(),
    source: z.string().max(100).optional(),
    notes: z.string().optional(),
    conversation: z.array(z.object({
        from: z.enum(['user', 'bot', 'human']),
        text: z.string(),
        timestamp: z.string().or(z.date()),
    })).optional(),
});

const updateLeadSchema = createLeadSchema.partial();

const createTicketSchema = z.object({
    title: z.string().min(1).max(200),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignedTo: z.string().max(100).optional(),
    message: z.string().optional(),
});

const updateTicketSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    status: z.enum(['open', 'in_progress', 'resolved']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assignedTo: z.string().max(100).optional(),
});

// ─── AI Response Schemas ─────────────────────────────────────────

const intentResponseSchema = z.object({
    intent: z.enum(['FAQ', 'SALES', 'CUSTOM', 'HANDOFF_HUMAN']),
    confidence: z.number().min(0).max(1).optional(),
    profileUrl: z.string().url().nullable().optional(),
    reasoning: z.string().optional(),
});

const visionResponseSchema = z.object({
    response: z.string(),
    profileUrl: z.string().url().nullable().optional(),
    extractedData: z.record(z.unknown()).optional(),
});

// ─── Webhook Schemas ─────────────────────────────────────────────

const webhookPayloadSchema = z.object({
    clientId: z.string(),
    event: z.enum(['message', 'connection', 'error']),
    data: z.record(z.unknown()),
    timestamp: z.string().or(z.number()),
});

// ─── OTP Schema ─────────────────────────────────────────────────

const requestOTPSchema = z.object({
    phone: z.string().regex(phoneRegex, 'Invalid phone number'),
});

export {
    registerSchema,
    loginSchema,
    updateProfileSchema,
    passwordResetRequestSchema,
    passwordResetSchema,
    onboardingStep1Schema,
    onboardingStep2Schema,
    onboardingStep3Schema,
    setPasswordSchema,
    createLeadSchema,
    updateLeadSchema,
    createTicketSchema,
    updateTicketSchema,
    intentResponseSchema,
    visionResponseSchema,
    webhookPayloadSchema,
    requestOTPSchema,
};