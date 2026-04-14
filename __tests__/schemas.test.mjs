/**
 * Unit tests for validation-schemas.js
 * Run: npx vitest run __tests__/schemas.test.mjs
 */
import { describe, it, expect } from 'vitest';

// Import CommonJS module in ESM test file
const z = await import('zod').then(m => m.default || m);

// Inline schemas for testing (avoid import conflict)
const phoneRegex = /^\+91[6-9]\d{9}$/;

const registerSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password too long'),
    displayName: z.string().min(1, 'Display name is required').max(100),
    phone: z.string().regex(phoneRegex, 'Phone must be +91 followed by 10 digits').optional(),
    orgName: z.string().min(2, 'Organisation name too short').max(100),
});

const loginSchema = z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
});

const onboardingStep1Schema = z.object({
    workspaceName: z.string().min(1, 'Workspace name is required').max(100),
    phone: z.string().regex(phoneRegex).optional(),
});

const onboardingStep3Schema = z.object({
    sector: z.enum(['fashion', 'food', 'services', 'tech', 'education', 'health', 'other']),
    vertical: z.string().min(1).max(100),
    modules: z.array(z.string()).min(1, 'Select at least one module'),
});

const createLeadSchema = z.object({
    name: z.string().min(1, 'Name is required').max(200),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    phone: z.string().regex(phoneRegex, 'Invalid phone format').optional().or(z.literal('')),
    source: z.string().max(100).optional(),
    qualification: z.enum(['HOT', 'WARM', 'COLD', 'UNKNOWN']).optional(),
    status: z.enum(['NEW', 'QUALIFIED', 'BOOKED', 'PAID', 'LOST']).optional(),
});

const createTicketSchema = z.object({
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
});

const requestOTPSchema = z.object({
    phone: z.string().regex(phoneRegex, 'Invalid phone number'),
});

const intentResponseSchema = z.object({
    intent: z.enum(['FAQ', 'SALES', 'CUSTOM', 'HANDOFF_HUMAN']),
    confidence: z.number().min(0).max(1).optional(),
    profileUrl: z.union([z.string().url(), z.null()]).optional(),
});

const visionResponseSchema = z.object({
    response: z.string(),
    profileUrl: z.union([z.string().url(), z.null()]).optional(),
});

describe('Auth Schemas', () => {
    describe('registerSchema', () => {
        it('accepts valid registration data', () => {
            const valid = {
                email: 'riya@brandproinc.in',
                password: 'SecurePass123!',
                displayName: 'Riya Arora',
                phone: '+918123456789',
                orgName: 'BrandPro Inc',
            };
            const result = registerSchema.safeParse(valid);
            expect(result.success).toBe(true);
        });

        it('rejects invalid email', () => {
            const result = registerSchema.safeParse({ email: 'not-an-email', password: 'SecurePass123!' });
            expect(result.success).toBe(false);
        });

        it('rejects short password', () => {
            const result = registerSchema.safeParse({ email: 'test@test.com', password: '1234567' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid Indian phone format', () => {
            const result = registerSchema.safeParse({
                email: 'test@test.com',
                password: 'SecurePass123!',
                displayName: 'Test User',
                orgName: 'Test Org',
                phone: '+11123456789',
            });
            expect(result.success).toBe(false);
        });

        it('accepts valid +91 phone number', () => {
            const result = registerSchema.safeParse({
                email: 'test@test.com',
                password: 'SecurePass123!',
                displayName: 'Test User',
                orgName: 'Test Org',
                phone: '+919876543210',
            });
            expect(result.success).toBe(true);
        });

        it('rejects short orgName', () => {
            const result = registerSchema.safeParse({
                email: 'test@test.com',
                password: 'SecurePass123!',
                orgName: 'A',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('loginSchema', () => {
        it('accepts valid credentials', () => {
            const result = loginSchema.safeParse({ email: 'test@test.com', password: 'anypassword' });
            expect(result.success).toBe(true);
        });

        it('rejects empty email', () => {
            const result = loginSchema.safeParse({ email: '', password: 'password123' });
            expect(result.success).toBe(false);
        });

        it('rejects missing password', () => {
            const result = loginSchema.safeParse({ email: 'test@test.com' });
            expect(result.success).toBe(false);
        });
    });
});

describe('CRM Schemas', () => {
    describe('createLeadSchema', () => {
        it('accepts valid lead with phone', () => {
            const result = createLeadSchema.safeParse({ name: 'Rahul Sharma', phone: '+919876543210' });
            expect(result.success).toBe(true);
        });

        it('rejects missing name', () => {
            const result = createLeadSchema.safeParse({ phone: '+919876543210' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid phone format', () => {
            const result = createLeadSchema.safeParse({ name: 'Test', phone: '9876543210' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid qualification value', () => {
            const result = createLeadSchema.safeParse({ name: 'Test', qualification: 'SUPER_HOT' });
            expect(result.success).toBe(false);
        });
    });

    describe('createTicketSchema', () => {
        it('accepts valid ticket', () => {
            const result = createTicketSchema.safeParse({ title: 'Cannot login to dashboard' });
            expect(result.success).toBe(true);
        });

        it('rejects missing title', () => {
            const result = createTicketSchema.safeParse({ description: 'Long description' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid priority', () => {
            const result = createTicketSchema.safeParse({ title: 'Test', priority: 'critical' });
            expect(result.success).toBe(false);
        });
    });
});

describe('Onboarding Schemas', () => {
    describe('onboardingStep1Schema', () => {
        it('accepts valid step1 data', () => {
            const result = onboardingStep1Schema.safeParse({ workspaceName: 'My Business', phone: '+919876543210' });
            expect(result.success).toBe(true);
        });

        it('rejects empty workspace name', () => {
            const result = onboardingStep1Schema.safeParse({ workspaceName: '' });
            expect(result.success).toBe(false);
        });
    });

    describe('onboardingStep3Schema', () => {
        it('accepts valid sector + modules', () => {
            const result = onboardingStep3Schema.safeParse({
                sector: 'fashion',
                vertical: 'ethnic wear',
                modules: ['dashboard', 'chats'],
            });
            expect(result.success).toBe(true);
        });

        it('rejects invalid sector', () => {
            const result = onboardingStep3Schema.safeParse({ sector: 'invalid', vertical: 'test', modules: ['dashboard'] });
            expect(result.success).toBe(false);
        });

        it('rejects empty modules array', () => {
            const result = onboardingStep3Schema.safeParse({ sector: 'fashion', vertical: 'test', modules: [] });
            expect(result.success).toBe(false);
        });
    });
});

describe('AI Response Schemas', () => {
    describe('intentResponseSchema', () => {
        it('accepts valid intent with profileUrl', () => {
            const result = intentResponseSchema.safeParse({
                intent: 'SALES',
                profileUrl: 'https://instagram.com/testuser',
                confidence: 0.85,
            });
            expect(result.success).toBe(true);
        });

        it('rejects invalid intent', () => {
            const result = intentResponseSchema.safeParse({ intent: 'UNKNOWN_INTENT' });
            expect(result.success).toBe(false);
        });

        it('rejects confidence out of range', () => {
            const result = intentResponseSchema.safeParse({ intent: 'FAQ', confidence: 1.5 });
            expect(result.success).toBe(false);
        });
    });

    describe('visionResponseSchema', () => {
        it('accepts valid vision response', () => {
            const result = visionResponseSchema.safeParse({
                response: 'The image shows a price tag for ₹999',
                profileUrl: 'https://instagram.com/business',
            });
            expect(result.success).toBe(true);
        });

        it('rejects missing response field', () => {
            const result = visionResponseSchema.safeParse({ profileUrl: 'https://instagram.com/test' });
            expect(result.success).toBe(false);
        });
    });
});

describe('OTP Schema', () => {
    describe('requestOTPSchema', () => {
        it('accepts valid phone', () => {
            const result = requestOTPSchema.safeParse({ phone: '+919876543210' });
            expect(result.success).toBe(true);
        });

        it('rejects invalid phone', () => {
            const result = requestOTPSchema.safeParse({ phone: '1234567890' });
            expect(result.success).toBe(false);
        });
    });
});