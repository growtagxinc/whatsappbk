/**
 * Reusable Zod validation middleware for Express routes.
 *
 * Usage:
 *   const validate = require('./validate-middleware');
 *   router.post('/register', validate(registerSchema), handler);
 *
 * On validation failure, responds with 400:
 *   { error: 'VALIDATION_ERROR', message: '...', errors: { field: ['message'] } }
 *
 * On success, sets req.validatedBody = parsed data.
 */

const { errorHandler } = require('./errors');

/**
 * Creates Express middleware that validates req.body against a Zod schema.
 * @param {import('zod').ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            return res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Invalid request data',
                errors: result.error.flatten(),
            });
        }

        req.validatedBody = result.data;
        next();
    };
}

/**
 * Creates middleware for validating query params.
 * @param {import('zod').ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);

        if (!result.success) {
            return res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Invalid query parameters',
                errors: result.error.flatten(),
            });
        }

        req.validatedQuery = result.data;
        next();
    };
}

/**
 * Creates middleware for validating route params.
 * @param {import('zod').ZodSchema} schema
 * @returns {import('express').RequestHandler}
 */
function validateParams(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.params);

        if (!result.success) {
            return res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Invalid route parameters',
                errors: result.error.flatten(),
            });
        }

        req.validatedParams = result.data;
        next();
    };
}

module.exports = { validate, validateQuery, validateParams };