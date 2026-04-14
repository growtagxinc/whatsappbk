/**
 * Centralized Error Classes for ConcertOS
 *
 * All API errors use these classes for consistent structure:
 * - name: machine-readable slug
 * - message: human-readable
 * - status: HTTP status code
 * - errors: Zod.flattened() field errors
 */

/**
 * @param {string} name
 * @param {number} status
 * @param {string} message
 */
function createError(name, status, message) {
    class ConcertOSError extends Error {
        constructor(message, details = {}) {
            super(message);
            this.name = name;
            this.status = status;
            this.details = details;
            Error.captureStackTrace(this, this.constructor);
        }

        toJSON() {
            return {
                error: this.name,
                message: this.message,
                ...this.details,
            };
        }
    }
    return ConcertOSError;
}

const ValidationError = createError('VALIDATION_ERROR', 400, 'Invalid request data');
const UnauthorizedError = createError('UNAUTHORIZED', 401, 'Authentication required');
const ForbiddenError = createError('FORBIDDEN', 403, 'You do not have permission');
const NotFoundError = createError('NOT_FOUND', 404, 'Resource not found');
const ConflictError = createError('CONFLICT', 409, 'Resource already exists');
const RateLimitError = createError('RATE_LIMIT', 429, 'Too many requests');
const InternalError = createError('INTERNAL_ERROR', 500, 'Something went wrong');
const ServiceUnavailableError = createError('SERVICE_UNAVAILABLE', 503, 'Service temporarily unavailable');

/**
 * Wrap an async route handler to catch and format errors.
 * @param {Function} fn
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Global error handler — place at end of router chain.
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errorHandler(err, req, res, next) {
    // Handle Zod validation errors
    if (err.name === 'ZodError') {
        return res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            errors: err.flatten(),
        });
    }

    // Handle known ConcertOS errors
    if (err.name && err.status) {
        return res.status(err.status).json(err.toJSON());
    }

    // Log unknown errors
    console.error('[ERROR]', err);

    // Don't expose internal errors in production
    const isDev = process.env.NODE_ENV === 'development';
    res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: isDev ? err.message : 'Something went wrong',
        ...(isDev && { stack: err.stack }),
    });
}

module.exports = {
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    RateLimitError,
    InternalError,
    ServiceUnavailableError,
    asyncHandler,
    errorHandler,
};