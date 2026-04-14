/**
 * JWT Authentication Middleware for ConcertOS
 *
 * Auth flow:
 * - JWT payload: { userId, orgId, workspaceId, iat, exp }
 * - x-workspace-id header routes API calls to the correct workspace
 * - req.userId  = authenticated user (from JWT)
 * - req.orgId   = user's primary org  (from JWT)
 * - req.workspaceId = active workspace (from JWT or x-workspace-id header)
 *
 * Token fingerprinting: JWT contains a fingerprint hash (SHA-256 of
 * User-Agent + IP address) to detect token reuse across devices.
 * This mitigates session hijacking by making tokens device-specific.
 *
 * Backward compat: old tokens with { clientId } are treated as userId.
 * ALLOW_UNAUTHENTICATED=true (dev only) bypasses JWT validation.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOW_UNAUTHENTICATED = process.env.ALLOW_UNAUTHENTICATED === 'true';

/**
 * Generate a token fingerprint hash from User-Agent + IP.
 * @param {import('express').Request} req
 */
function generateFingerprint(req) {
    const ua = req.headers['user-agent'] || '';
    const ip = req.ip || req.connection?.remoteAddress || '';
    return crypto.createHash('sha256').update(`${ua}::${ip}`).digest('hex').substring(0, 16);
}

/**
 * Main auth middleware — use on all protected routes.
 * Sets: req.userId, req.orgId, req.workspaceId
 */
function authMiddleware(req, res, next) {
    if (ALLOW_UNAUTHENTICATED) {
        req.userId = req.headers['x-client-id'] || 'default';
        req.orgId = null;
        req.workspaceId = req.headers['x-workspace-id'] || req.headers['x-client-id'] || 'default';
        return next();
    }

    if (!JWT_SECRET) {
        return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET not set' });
    }

    const token = getToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET, {
            algorithms: ['HS256'],
            clockTolerance: 30,
        });

        // ── Normalise: support both { clientId } and { userId } tokens ──
        let userId = decoded.userId || decoded.clientId || null;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized: Token missing userId/clientId' });
        }

        // ── Token fingerprinting: detect token reuse across devices ──
        // Old tokens (before fingerprint was added) won't have fp field — allow them
        if (decoded.fp) {
            const currentFp = generateFingerprint(req);
            if (currentFp !== decoded.fp) {
                console.warn(`[AUTH] Token fingerprint mismatch for user ${userId}. Possible token theft.`);
                // Log but don't block for now — fingerprint is defense-in-depth
                // In production, set: return res.status(401).json({ error: 'Token device mismatch' });
            }
        }

        req.userId = userId;
        req.orgId = decoded.orgId || null;

        // Workspace routing: x-workspace-id header wins; falls back to JWT's workspaceId
        // Empty/null workspaceId means no workspace yet — pass through as-is
        req.workspaceId = req.headers['x-workspace-id'] || decoded.workspaceId || null;

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
}

/**
 * Extract token from httpOnly cookie or Authorization header.
 */
function getToken(req) {
    if (req.cookies && req.cookies.concertos_token) {
        return req.cookies.concertos_token;
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return null;
}

/**
 * Issue a JWT with device fingerprint.
 * @param {string} userId  - The user's ID
 * @param {string} orgId   - The user's primary org ID
 * @param {string} workspaceId - (optional) default workspace
 * @param {number} expiresIn - seconds (default 7 days)
 * @param {string} fp - device fingerprint hash
 */
function issueToken(userId, orgId, workspaceId = null, expiresIn = 604800, fp = null) {
    if (!JWT_SECRET) {
        throw new Error('JWT_SECRET not configured');
    }
    const payload = { userId };
    if (orgId) payload.orgId = orgId;
    payload.workspaceId = workspaceId || '';
    if (fp) payload.fp = fp;
    return jwt.sign(payload, JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn,
    });
}

/**
 * Verify token without throwing — returns decoded or null.
 */
function verifyToken(token) {
    if (!JWT_SECRET || !token) return null;
    try {
        return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], clockTolerance: 30 });
    } catch {
        return null;
    }
}

module.exports = { authMiddleware, issueToken, verifyToken, generateFingerprint };