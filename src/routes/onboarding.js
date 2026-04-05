const express = require('express');
const router = express.Router();
const Session = require('../../models/Session');
const Workspace = require('../../models/Workspace');
const AIConfig = require('../../models/AIConfig');
const User = require('../../models/User');
const { authMiddleware } = require('../lib/auth');

// All onboarding routes require authentication
router.use(authMiddleware);

/**
 * POST /api/onboarding/step1
 * Save workspace name + org name. Google OAuth users reach this first.
 *
 * Body: {
 *   workspaceName: string,
 *   orgName?: string (optional, mainly for Google OAuth users without existing org)
 * }
 */
router.post('/step1', async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId || !workspaceId) {
            return res.status(401).json({ error: 'No workspace. Please sign in first.' });
        }
        const { workspaceName, orgName, phone } = req.body;

        if (!workspaceName?.trim()) {
            return res.status(400).json({ error: 'Workspace name is required' });
        }

        const trimmedName = workspaceName.trim();

        // Update workspace name
        await Workspace.findOneAndUpdate(
            { workspaceId },
            { $set: { name: trimmedName } }
        );

        // Build Session update: always sync name fields; optionally sync phone
        const sessionUpdates = {
            businessName: trimmedName,
            workspaceName: trimmedName,
        };
        if (phone !== undefined) {
            sessionUpdates.phone = phone;
            // Also persist to canonical User.phone
            await User.findOneAndUpdate(
                { clientId: userId },
                { $set: { phone: phone } }
            );
        }

        await Session.updateOne(
            { workspaceId },
            { $set: sessionUpdates },
            { upsert: false }
        );
        await AIConfig.updateOne(
            { workspaceId },
            { $set: { businessName: trimmedName } },
            { upsert: false }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[Onboarding Step1 Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/onboarding/step2
 * Save AI personalization: agent name + daily tasks.
 *
 * Body: {
 *   aiAgentName: string,
 *   dailyTasks: string[],
 * }
 */
router.post('/step2', async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId || !workspaceId) {
            return res.status(401).json({ error: 'No workspace. Please sign in first.' });
        }
        const { aiAgentName, dailyTasks } = req.body;

        // Update AIConfig with agent name
        if (aiAgentName) {
            await AIConfig.findOneAndUpdate(
                { workspaceId },
                {
                    $set: {
                        'agents.vision.label': aiAgentName.trim(),
                        aiEnabled: true,
                    }
                },
                { upsert: false }
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Onboarding Step2 Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/onboarding/step3
 * Save sector + vertical + modules to the current workspace.
 *
 * Body: {
 *   sector: string,
 *   vertical: string,
 *   modules: string[],
 * }
 */
router.post('/step3', async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId || !workspaceId) {
            return res.status(401).json({ error: 'No workspace. Please complete registration first.' });
        }
        const { sector, vertical, modules } = req.body;

        const updateData = {
            ...(sector && { sector }),
            ...(vertical && { vertical }),
            ...(modules && { modules }),
        };

        const ws = await Workspace.findOneAndUpdate(
            { workspaceId },
            { $set: updateData },
            { new: true, upsert: false }
        );

        if (!ws) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        await Session.updateOne(
            { workspaceId },
            { $set: { onboardingStep: 3, sector: sector || '', vertical: vertical || '' } },
            { upsert: false }
        );

        await AIConfig.updateOne(
            { workspaceId },
            { $set: { sector: sector || '', vertical: vertical || '' } },
            { upsert: false }
        );

        res.json({
            success: true,
            workspace: {
                workspaceId: ws.workspaceId,
                name: ws.name,
                sector: ws.sector,
                vertical: ws.vertical,
                modules: ws.modules,
            },
        });
    } catch (err) {
        console.error('[Onboarding Step3 Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/onboarding/status
 * Get current workspace onboarding progress.
 */
router.get('/status', async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.json({ onboardingStep: 0, workspaceConfigured: false });
        }

        const ws = await Workspace.findOne({ workspaceId: userId }).lean();
        if (!ws) {
            return res.json({ onboardingStep: 0, workspaceConfigured: false });
        }

        const user = await User.findOne({ clientId: userId }).lean();

        res.json({
            onboardingStep: ws.sector ? 3 : 1,
            workspaceConfigured: !!(ws.sector && ws.vertical),
            sector: ws.sector || null,
            vertical: ws.vertical || null,
            modules: ws.modules || [],
            // Flag for Google users who need to set a password
            needsPassword: user?.authMethods?.includes('google') && !user?.password,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/onboarding/set-password
 * Set a real password for Google-authenticated users during onboarding.
 * Required before completing onboarding for Google users.
 */
router.post('/set-password', async (req, res) => {
    try {
        const { userId } = req;
        if (!userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const { password, confirmPassword } = req.body;

        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        if (password !== confirmPassword) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        const bcrypt = require('bcrypt');
        const SALT_ROUNDS = 12;
        const hashed = await bcrypt.hash(password, SALT_ROUNDS);

        const user = await User.findOneAndUpdate(
            { clientId: userId },
            {
                password: hashed,
                // Add 'password' to authMethods so user can login with password too
                $addToSet: { authMethods: 'password' },
            },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        console.log(`[Onboarding] Password set for Google user: ${user.email}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Onboarding set-password error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
