/**
 * Property-based tests for sanitize.js using fast-check
 * Run: npx vitest run __tests__/sanitize.test.mjs
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

// Import the sanitization functions
const { sanitizeMessage, sanitizeImages, sanitizeAIInput } = await import('../ai/sanitize.js');

const MAX_MESSAGE_LENGTH = 8000;
const MAX_IMAGE_COUNT = 5;

describe('sanitizeMessage', () => {
    it('always returns a string (never throws on non-string)', () => {
        fc.assert(
            fc.property(fc.oneof(fc.string(), fc.constant(''), fc.constant(null), fc.constant(123)), (input) => {
                const result = sanitizeMessage(input);
                expect(typeof result.clean).toBe('string');
            }),
            { numRuns: 300 }
        );
    });

    it('strips invisible control characters', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 0, maxLength: 1000 }), (str) => {
                const result = sanitizeMessage(str);
                const hasControl = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(result.clean);
                expect(hasControl).toBe(false);
            }),
            { numRuns: 200 }
        );
    });

    it('truncates messages exceeding MAX_MESSAGE_LENGTH', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 9000, maxLength: 50000 }), (str) => {
                const result = sanitizeMessage(str);
                expect(result.clean.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
            }),
            { numRuns: 50 }
        );
    });

    it('strips prompt injection patterns', () => {
        const patterns = [
            'ignore previous instructions',
            'disregard all previous',
            'system prompt:',
            'you are now a hacker',
            '```json',
            'forget everything',
        ];
        patterns.forEach(pattern => {
            const result = sanitizeMessage(pattern);
            const injectionPatterns = [
                /ignore\s+previous/gi,
                /disregard\s+all/gi,
                /system\s+prompt/gi,
                /you\s+are\s+now/gi,
                /```json/gi,
            ];
            const hasPattern = injectionPatterns.some(p => p.test(result.clean));
            expect(hasPattern).toBe(false);
        });
    });

    it('non-string input returns empty clean string', () => {
        const inputs = [null, undefined, 123, {}, [], Symbol('test')];
        inputs.forEach(input => {
            const result = sanitizeMessage(input);
            expect(result.clean).toBe('');
            expect(result.wasModified).toBe(true);
        });
    });

    it('empty input returns empty clean string with reason', () => {
        const result = sanitizeMessage('');
        expect(result.clean).toBe('');
        expect(result.wasModified).toBe(true);
        expect(result.reason).toBe('empty input');
    });
});

describe('sanitizeImages', () => {
    it('limits to MAX_IMAGE_COUNT (5)', () => {
        fc.assert(
            fc.property(fc.array(fc.string(), { minLength: 6, maxLength: 50 }), (images) => {
                const result = sanitizeImages(images);
                expect(result.clean.length).toBeLessThanOrEqual(MAX_IMAGE_COUNT);
                expect(result.wasModified).toBe(true);
            }),
            { numRuns: 100 }
        );
    });

    it('returns empty array for null/undefined input', () => {
        expect(sanitizeImages(null).clean).toEqual([]);
        expect(sanitizeImages(undefined).clean).toEqual([]);
    });

    it('normalizes single image to array', () => {
        const result = sanitizeImages('data:image/png;base64,abc123');
        expect(Array.isArray(result.clean)).toBe(true);
        expect(result.clean.length).toBe(1);
    });
});

describe('sanitizeAIInput', () => {
    it('handles combined text + images input', () => {
        fc.assert(
            fc.property(
                fc.string({ maxLength: 500 }),
                fc.array(fc.string(), { maxLength: 10 }),
                (text, images) => {
                    const result = sanitizeAIInput(text, images);
                    expect(typeof result.text).toBe('string');
                    expect(Array.isArray(result.images)).toBe(true);
                }
            ),
            { numRuns: 200 }
        );
    });

    it('handles null/undefined text gracefully', () => {
        expect(sanitizeAIInput(null, ['image1']).text).toBe('');
        expect(sanitizeAIInput(undefined, ['image1']).text).toBe('');
    });
});