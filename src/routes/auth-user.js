require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../../models/User');
const Organisation = require('../../models/Organisation');
const OrgMember = require('../../models/OrgMember');
const Workspace = require('../../models/Workspace');
const Session = require('../../models/Session');
const AIConfig = require('../../models/AIConfig');
const { issueToken, verifyToken } = require('../lib/auth');

const router = express.Router();
const JWT_COOKIE_NAME = 'concertos_token';
const SALT_ROUNDS = 12;

// ─── Helpers ───────────────────────────────────────────────────

function setTokenCookie(res, token) {
    res.cookie(JWT_COOKIE_NAME, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
        domain: '.brandproinc.in',
    });
}

function clearTokenCookie(res) {
    res.clearCookie(JWT_COOKIE_NAME, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        domain: '.brandproinc.in',
    });
}

function getTokenFromRequest(req) {
    if (req.cookies && req.cookies[JWT_COOKIE_NAME]) {
        return req.cookies[JWT_COOKIE_NAME];
    }
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return null;
}

function requireAuth(req, res, next) {
    const token = getTokenFromRequest(req);
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }
    const decoded = verifyToken(token);
    if (!decoded || !decoded.userId) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    // Backward compat: clientId in old tokens = userId
    const userId = decoded.userId || decoded.clientId || null;
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    req.userId = userId;
    req.orgId = decoded.orgId || null;
    // Workspace from header (x-workspace-id) or JWT; null means no workspace yet
    req.workspaceId = req.headers['x-workspace-id'] || decoded.workspaceId || null;
    next();
}

// ─── Lazy Migration ───────────────────────────────────────────
// Migrates existing pre-org users to the new multi-tenant model.
// Safe to call multiple times — idempotent.

async function lazyMigrateUser(user) {
    // Check if already migrated
    const existingMember = await OrgMember.findOne({ userId: user.clientId });
    if (existingMember) return existingMember;

    const orgId = `org_${crypto.randomUUID()}`;
    const workspaceId = `ws_${crypto.randomUUID()}`;

    // Get existing session and AI config
    const session = await Session.findOne({ clientId: user.clientId });
    const aiConfig = await AIConfig.findOne({ clientId: user.clientId });

    // Create Organisation
    const orgName = session?.businessName?.trim() || user.displayName?.trim() || user.email.split('@')[0];
    const org = new Organisation({
        orgId,
        name: orgName,
        plan: 'trial',
        trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    await org.save();

    // Create OrgMember
    const member = new OrgMember({
        userId: user.clientId,
        orgId,
        role: 'owner',
        invitedBy: null,
    });
    await member.save();

    // Create Workspace (migrate from Session + AIConfig)
    const workspace = new Workspace({
        workspaceId,
        orgId,
        name: session?.businessName?.trim() || orgName,
        sector: aiConfig?.sector || '',
        vertical: aiConfig?.vertical || '',
        modules: ['dashboard', 'chats', 'tickets'],
        language: aiConfig?.language || 'en',
        aiEnabled: aiConfig?.aiEnabled ?? true,
        agents: aiConfig?.agents || {},
        legacyClientId: user.clientId,
    });
    await workspace.save();

    // Update Session with migration fields
    if (session) {
        session.orgId = orgId;
        session.workspaceId = workspaceId;
        await session.save();
    }

    // Update AIConfig with migration fields
    if (aiConfig) {
        aiConfig.orgId = orgId;
        aiConfig.workspaceId = workspaceId;
        await aiConfig.save();
    }

    // Update User.primaryOrgId
    user.primaryOrgId = orgId;
    await user.save();

    return member;
}

// ─── Build /me response ───────────────────────────────────────
async function buildMeResponse(userId, orgId, workspaceId) {
    const user = await User.findOne({ clientId: userId, isActive: true });
    if (!user) return null;

    // Lazy migrate if needed
    if (!orgId) {
        await lazyMigrateUser(user);
        const member = await OrgMember.findOne({ userId });
        if (member) orgId = member.orgId;
    }

    let org = null;
    let workspaces = [];
    let role = null;
    let currentWorkspace = null;

    if (orgId) {
        org = await Organisation.findOne({ orgId });
        const members = await OrgMember.find({ orgId });
        role = members.find(m => m.userId === userId)?.role || 'member';
        workspaces = await Workspace.find({ orgId }).select('workspaceId name sector vertical modules');

        if (workspaceId) {
            currentWorkspace = workspaces.find(w => w.workspaceId === workspaceId) || null;
        }
        if (!currentWorkspace && workspaces.length > 0) {
            currentWorkspace = workspaces[0];
            workspaceId = currentWorkspace.workspaceId;
        }
    }

    return {
        user: {
            email: user.email,
            displayName: user.displayName,
            phone: user.phone,
            userId: user.clientId,
            primaryOrgId: user.primaryOrgId,
            authMethods: user.authMethods,
            hasGoogle: user.authMethods.includes('google'),
        },
        org: org ? {
            orgId: org.orgId,
            name: org.name,
            plan: org.plan,
            trialEndsAt: org.trialEndsAt,
        } : null,
        workspaces: workspaces.map(w => ({
            workspaceId: w.workspaceId,
            name: w.name,
            sector: w.sector,
            vertical: w.vertical,
            modules: w.modules,
        })),
        currentWorkspace: currentWorkspace ? {
            workspaceId: currentWorkspace.workspaceId,
            name: currentWorkspace.name,
            sector: currentWorkspace.sector,
            vertical: currentWorkspace.vertical,
            modules: currentWorkspace.modules,
            language: currentWorkspace.language,
            aiEnabled: currentWorkspace.aiEnabled,
            agents: currentWorkspace.agents,
        } : null,
        role,
    };
}

// ─── POST /api/auth/register ───────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { email, password, orgName, workspaceName, phone, displayName } = req.body;

        if (!email || !password || !orgName) {
            return res.status(400).json({ error: 'Email, password, and organisation name are required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const existingUser = await User.findOne({ email: normalizedEmail, isActive: true });
        if (existingUser) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }

        // Generate IDs
        const userId = `usr_${crypto.randomUUID()}`;
        const orgId = `org_${crypto.randomUUID()}`;
        const workspaceId = `ws_${crypto.randomUUID()}`;
        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

        // ── Create Organisation ──────────────────────────────
        const org = new Organisation({
            orgId,
            name: orgName.trim(),
            plan: 'trial',
            trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        });
        await org.save();

        // ── Create OrgMember ────────────────────────────────
        const member = new OrgMember({
            userId,
            orgId,
            role: 'owner',
        });
        await member.save();

        // ── Create User ────────────────────────────────────
        const user = new User({
            clientId: userId,
            email: normalizedEmail,
            password: hashedPassword,
            phone: phone || '',
            displayName: displayName || orgName.trim(),
            authMethods: ['password'],
            primaryOrgId: orgId,
        });
        await user.save();

        // ── Create Workspace ────────────────────────────────
        const ws = new Workspace({
            workspaceId,
            orgId,
            name: (workspaceName || orgName).trim(),
        });
        await ws.save();

        // ── Create Session (legacy WhatsApp state container) ─
        const session = new Session({
            clientId: userId,
            orgId,
            workspaceId,
            email: normalizedEmail,
            displayName: displayName || orgName.trim(),
            businessName: (workspaceName || orgName).trim(),
            workspaceName: (workspaceName || orgName).trim(),
            phone: phone || '',
            company: orgName.trim(),
            onboardingStep: 1,
        });
        await session.save();

        // ── Create AIConfig ────────────────────────────────
        const aiConfig = new AIConfig({
            clientId: userId,
            orgId,
            workspaceId,
            businessName: (workspaceName || orgName).trim(),
        });
        await aiConfig.save();

        // ── Issue JWT ─────────────────────────────────────
        const token = issueToken(userId, orgId, workspaceId);
        setTokenCookie(res, token);

        res.status(201).json({
            success: true,
            token,  // Exposed so frontend can store in localStorage for Bearer auth
            user: {
                email: user.email,
                displayName: user.displayName,
                phone: user.phone,
                userId: user.clientId,
            },
            org: {
                orgId: org.orgId,
                name: org.name,
                plan: org.plan,
                trialEndsAt: org.trialEndsAt,
            },
            workspaces: [{
                workspaceId: ws.workspaceId,
                name: ws.name,
                sector: '',
                vertical: '',
                modules: ws.modules,
            }],
            currentWorkspace: {
                workspaceId: ws.workspaceId,
                name: ws.name,
                sector: '',
                vertical: '',
                modules: ws.modules,
            },
            role: 'owner',
            redirect: '/onboarding',
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// ─── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const user = await User.findOne({ email: normalizedEmail, isActive: true });
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        user.lastLogin = new Date();
        await user.save();

        // Lazy migration (existing users)
        const member = await lazyMigrateUser(user);
        const orgId = user.primaryOrgId || member?.orgId || null;

        // Get first workspace
        let workspaceId = null;
        if (orgId) {
            const ws = await Workspace.findOne({ orgId }).sort({ createdAt: 1 });
            workspaceId = ws?.workspaceId || null;
        }

        const token = issueToken(user.clientId, orgId, workspaceId);
        setTokenCookie(res, token);

        // Sync canonical fields + workspaceId/orgId into Session (upsert in case session was wiped)
        await Session.findOneAndUpdate(
            { clientId: user.clientId },
            {
                $set: {
                    phone: user.phone || '',
                    email: user.email || '',
                    displayName: user.displayName || '',
                    workspaceId: workspaceId,
                    orgId: orgId,
                }
            },
            { upsert: true, new: true }
        );

        // Check if user has completed onboarding: Session.onboardingStep >= 3
        const session = await Session.findOne({ clientId: user.clientId });
        const hasOnboarded = session ? session.onboardingStep >= 3 : false;

        res.json({
            success: true,
            token,  // Exposed so frontend can store in localStorage for Bearer auth
            user: {
                email: user.email,
                displayName: user.displayName,
                phone: user.phone,
                userId: user.clientId,
                primaryOrgId: user.primaryOrgId,
            },
            redirect: hasOnboarded ? '/' : '/onboarding',
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ─── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', (req, res) => {
    clearTokenCookie(res);
    res.json({ success: true });
});

// ─── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
    try {
        const data = await buildMeResponse(req.userId, req.orgId, req.workspaceId);
        if (!data) {
            return res.status(404).json({ error: 'User not found' });
        }
        // Issue a fresh token so frontend can store in localStorage for Bearer auth
        const token = issueToken(req.userId, req.orgId, req.workspaceId);
        res.json({ ...data, token });
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// ─── Google OAuth ──────────────────────────────────────────────
const GOOGLE_CALLBACK = 'http://engine.brandproinc.in/api/auth/google/callback';

router.get('/google/register', (req, res) => {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_CALLBACK
    );

    const state = Buffer.from(JSON.stringify({ action: 'register' })).toString('base64');
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        state,
        prompt: 'consent',
        redirect_uri: GOOGLE_CALLBACK,
    });
    res.redirect(url);
});

router.get('/google/login', (req, res) => {
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        GOOGLE_CALLBACK
    );

    const state = Buffer.from(JSON.stringify({ action: 'login' })).toString('base64');
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
        ],
        state,
        prompt: 'consent',
        redirect_uri: GOOGLE_CALLBACK,
    });
    res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
    try {
        const { code, state: stateParam } = req.query;
        if (!code || !stateParam) {
            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=missing_params`);
        }

        let parsedState;
        try {
            parsedState = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf8'));
        } catch {
            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=invalid_state`);
        }

        let { action } = parsedState;

        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            GOOGLE_CALLBACK
        );
        console.log('[GoogleOAuth] Exchanging code with redirect_uri:', GOOGLE_CALLBACK, 'code length:', code ? code.length : 0);
        let tokens;
        try {
            tokens = await oauth2Client.getToken(code);
        } catch (err) {
            console.error('[GoogleOAuth] Token exchange failed:', err.message);
            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=token_exchange_failed`);
        }
        // getToken may return { tokens: {...} } or just {...} — normalize it
        const creds = tokens.tokens || tokens;
        console.log('[GoogleOAuth] Tokens received, access_token:', creds?.access_token ? 'YES' : 'NO');
        oauth2Client.setCredentials(creds);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        let googleUser;
        try {
            const resp = await oauth2.userinfo.get({});
            googleUser = resp.data;
            console.log('[GoogleOAuth] Userinfo OK:', googleUser?.email);
        } catch (err) {
            console.error('[GoogleOAuth] Userinfo failed:', err.message);
            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=userinfo_failed`);
        }

        if (!googleUser || !googleUser.email) {
            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=no_google_email`);
        }

        const googleEmail = googleUser.email.toLowerCase();
        const googleId = googleUser.id;
        console.log('[GoogleOAuth] action:', action, '| email:', googleEmail);

        if (action === 'register') {
            const existingUser = await User.findOne({ email: googleEmail, isActive: true });
            if (existingUser) {
                console.log('[GoogleOAuth] Email exists, treating as login');
                action = 'login'; // fall through to login flow
            } else {
                console.log('[GoogleOAuth] Creating new account for:', googleEmail);
            }
        }

        if (action === 'register') {

            const userId = `usr_${crypto.randomUUID()}`;
            const orgId = `org_${crypto.randomUUID()}`;
            const workspaceId = `ws_${crypto.randomUUID()}`;
            const orgName = googleUser.name || 'My Organisation';
            const wsName = googleUser.name || 'My Workspace';

            // Create org + member
            const org = new Organisation({
                orgId,
                name: orgName,
                plan: 'trial',
                trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            });
            await org.save();

            const member = new OrgMember({ userId, orgId, role: 'owner' });
            await member.save();

            // Create user — password set during onboarding
            const user = new User({
                clientId: userId,
                email: googleEmail,
                password: '', // Set during onboarding via /api/onboarding/set-password
                displayName: googleUser.name || googleUser.given_name || 'User',
                phone: '',
                authMethods: ['google'],
                googleId,
                googleTokens: oauth2Client.credentials,
                googleEmail,
                primaryOrgId: orgId,
            });
            await user.save();

            // Create workspace
            const ws = new Workspace({ workspaceId, orgId, name: wsName });
            await ws.save();

            // Create session + aiConfig
            await new Session({
                clientId: userId,
                orgId,
                workspaceId,
                email: googleEmail,
                displayName: googleUser.name || 'User',
                businessName: wsName,
                workspaceName: wsName,
                phone: '',  // Google OAuth doesn't provide phone; user adds via Settings
                company: orgName,
                onboardingStep: 1,
            }).save();

            await new AIConfig({
                clientId: userId,
                orgId,
                workspaceId,
                businessName: wsName,
            }).save();

            const token = issueToken(userId, orgId, workspaceId);
            setTokenCookie(res, token);

            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}?registered=1`);

        } else if (action === 'login') {
            const user = await User.findOne({ email: googleEmail, isActive: true });
            if (!user) {
                console.log('[GoogleOAuth] No account found for:', googleEmail);
                return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=no_account&email=${encodeURIComponent(googleEmail)}`);
            }

            if (!user.authMethods.includes('google')) {
                user.authMethods.push('google');
            }
            user.googleTokens = oauth2Client.credentials;
            user.lastLogin = new Date();
            await user.save();

            const member = await lazyMigrateUser(user);
            const orgId = user.primaryOrgId || member?.orgId || null;
            let workspaceId = null;
            if (orgId) {
                const ws = await Workspace.findOne({ orgId }).sort({ createdAt: 1 });
                workspaceId = ws?.workspaceId || null;
            }

            const token = issueToken(user.clientId, orgId, workspaceId);
            console.log('[GoogleOAuth] Login token issued for:', user.email, '| token:', token.substring(0, 30) + '...');
            setTokenCookie(res, token);

            // Sync canonical fields + workspaceId/orgId into Session (upsert in case session was wiped)
            await Session.findOneAndUpdate(
                { clientId: user.clientId },
                {
                    $set: {
                        phone: user.phone || '',
                        email: user.email || '',
                        displayName: user.displayName || '',
                        workspaceId: workspaceId,
                        orgId: orgId,
                    }
                },
                { upsert: true, new: true }
            );

            const redirectUrl = `${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}?logged_in=1`;
            console.log('[GoogleOAuth] Redirecting to:', redirectUrl);
            return res.redirect(redirectUrl);

        } else {
            return res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=invalid_action`);
        }
    } catch (err) {
        console.error('Google OAuth error:', err);
        res.redirect(`${process.env.FRONTEND_URL || 'https://dash.concertos.brandproinc.in'}/login?error=oauth_failed`);
    }
});

// ─── PUT /api/auth/profile ────────────────────────────────────────
router.put('/profile', requireAuth, async (req, res) => {
    try {
        const { displayName, email, phone, company } = req.body;
        const updates = {};
        if (displayName !== undefined) updates.displayName = displayName;
        if (phone !== undefined) updates.phone = phone;

        // Company name lives on the Organisation — update it if present
        if (company !== undefined && req.orgId) {
            await Organisation.findOneAndUpdate({ orgId: req.orgId }, { name: company });
        }

        // Email change requires unique check
        if (email !== undefined) {
            const existing = await User.findOne({ email: email.toLowerCase().trim(), isActive: true });
            if (existing && existing.clientId !== req.userId) {
                return res.status(409).json({ error: 'This email is already in use.' });
            }
            updates.email = email.toLowerCase().trim();
        }

        if (Object.keys(updates).length > 0) {
            await User.findOneAndUpdate({ clientId: req.userId }, { $set: updates });
        }

        // Also update Session convenience mirrors
        await Session.findOneAndUpdate({ clientId: req.userId }, {
            $set: {
                displayName: displayName !== undefined ? displayName : undefined,
                email: email !== undefined ? email : undefined,
                businessName: company !== undefined ? company : undefined,
                phone: phone !== undefined ? phone : undefined,
                company: company !== undefined ? company : undefined,
            }
        });

        res.json({ success: true });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

// ─── Password Reset ───────────────────────────────────────────

router.post('/password/reset-request', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });
        // TODO: Generate reset token + send email via Nodemailer
        res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process request' });
    }
});

router.post('/password/reset', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword || newPassword.length < 8) {
            return res.status(400).json({ error: 'Token and valid password required' });
        }
        // TODO: Verify reset token + update password
        res.json({ success: true, message: 'Password updated. Please log in.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

module.exports = router;
