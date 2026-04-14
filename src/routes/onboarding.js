const express = require('express');
const router = express.Router();
const Session = require('../../models/Session');
const Workspace = require('../../models/Workspace');
const AIConfig = require('../../models/AIConfig');
const User = require('../../models/User');
const { authMiddleware } = require('../lib/auth');
const { z } = require('zod');
const { validate } = require('../lib/validate-middleware');
const { createOnboardingMachine, getOnboardingState, canAdvanceTo } = require('../lib/onboarding-machine');
const { createActor } = require('xstate');

// All onboarding routes require authentication
router.use(authMiddleware);

// ── Onboarding State Machine Store ─────────────────────────────────
// In-memory actors per workspace. In production, persist state to MongoDB.
const onboardingActors = new Map(); // workspaceId → { actor, state }

/**
 * Get or create an onboarding actor for a workspace.
 * State is restored from Session.onboardingStep if present.
 */
function getOnboardingActor(workspaceId, existingStep) {
    if (!onboardingActors.has(workspaceId)) {
        const machine = createOnboardingMachine({ workspaceId });
        const actor = createActor(machine);

        // Restore state from persisted onboarding step
        const stateMap = { 1: 'step1', 2: 'step2', 3: 'step3', 4: 'complete' };
        if (existingStep && stateMap[existingStep]) {
            // Send all completed steps to reach the restored state
            actor.start();
            if (existingStep >= 1) actor.send({ type: 'COMPLETE_STEP_1' });
            if (existingStep >= 2) actor.send({ type: 'COMPLETE_STEP_2' });
            if (existingStep >= 3) actor.send({ type: 'COMPLETE_STEP_3' });
        } else {
            actor.start();
        }

        onboardingActors.set(workspaceId, actor);
        return actor;
    }
    return onboardingActors.get(workspaceId);
}

/**
 * Advance the onboarding state machine and persist to MongoDB.
 * Returns { success, state, error }
 */
async function advanceOnboarding(workspaceId, stepEvent, eventData, existingStep) {
    const actor = getOnboardingActor(workspaceId, existingStep);
    const currentState = actor.getSnapshot().value;

    if (!actor.getSnapshot().can({ type: stepEvent })) {
        return { success: false, error: `Cannot send ${stepEvent} from state: ${currentState}` };
    }

    actor.send({ type: stepEvent, data: eventData });

    // Persist new state to Session
    const newState = actor.getSnapshot().value;
    const stepMap = { step1: 1, step2: 2, step3: 3, complete: 4 };
    await Session.findOneAndUpdate(
        { workspaceId },
        { $set: { onboardingStep: stepMap[newState] || existingStep } }
    ).catch(() => {});

    return {
        success: true,
        state: getOnboardingState(actor.getSnapshot()),
    };
}

// ── Zod Schemas for Onboarding ───────────────────────────────────────
const phoneRegex = /^\+91[6-9]\d{9}$/;

const Step1Schema = z.object({
    workspaceName: z.string().min(1, 'Workspace name is required').max(100),
    orgName: z.string().min(1).max(100).optional(),
    phone: z.string().regex(phoneRegex).optional(),
});

const Step2Schema = z.object({
    aiAgentName: z.string().min(1).max(50).optional(),
    dailyTasks: z.boolean().optional(),
});

const Step3Schema = z.object({
    sector: z.enum(['fashion', 'food', 'services', 'tech', 'education', 'health', 'other']),
    vertical: z.string().min(1).max(100),
    modules: z.array(z.string()).min(1, 'Select at least one module'),
});

/**
 * POST /api/onboarding/step1
 * Save workspace name + org name. Google OAuth users reach this first.
 * Uses XState machine to enforce valid state transitions.
 *
 * Body: {
 *   workspaceName: string,
 *   orgName?: string (optional, mainly for Google OAuth users without existing org)
 * }
 */
router.post('/step1', validate(Step1Schema), async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId || !workspaceId) {
            return res.status(401).json({ error: 'No workspace. Please sign in first.' });
        }
        const { workspaceName, orgName, phone } = req.validatedBody;

        const trimmedName = workspaceName.trim();

        // Get current onboarding step from Session (for state restoration)
        const session = await Session.findOne({ workspaceId }).lean().catch(() => null);
        const existingStep = session?.onboardingStep || 1;

        // ── State Machine Transition ──────────────────────────────
        // The state machine guarantees: step 1 can only be reached from step 1 state.
        // Sending COMPLETE_STEP_1 transitions: step1 → step2 (or stay if already done).
        const result = await advanceOnboarding(
            workspaceId,
            'COMPLETE_STEP_1',
            { workspaceName: trimmedName, phone: phone || null },
            existingStep
        );

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        // ── Persist workspace data ───────────────────────────────
        await Workspace.findOneAndUpdate(
            { workspaceId },
            { $set: { name: trimmedName } }
        );

        const sessionUpdates = {
            businessName: trimmedName,
            workspaceName: trimmedName,
        };
        if (phone !== undefined) {
            sessionUpdates.phone = phone;
            await User.findOneAndUpdate(
                { clientId: userId },
                { $set: { phone: phone } }
            );
        }

        await Session.updateOne(
            { workspaceId },
            { $set: { ...sessionUpdates, onboardingStep: 2 } },
            { upsert: false }
        );
        await AIConfig.updateOne(
            { workspaceId },
            { $set: { businessName: trimmedName } },
            { upsert: false }
        );

        res.json({
            success: true,
            onboarding: result.state,
        });
    } catch (err) {
        console.error('[Onboarding Step1 Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/onboarding/step2
 * Save AI personalization: agent name + daily tasks.
 * Uses XState machine to enforce: step2 cannot be accessed before step1 completes.
 */
router.post('/step2', validate(Step2Schema), async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId || !workspaceId) {
            return res.status(401).json({ error: 'No workspace. Please sign in first.' });
        }
        const { aiAgentName, dailyTasks } = req.validatedBody;

        // ── State Machine Transition ──────────────────────────────
        const session = await Session.findOne({ workspaceId }).lean().catch(() => null);
        const existingStep = session?.onboardingStep || 1;

        const result = await advanceOnboarding(
            workspaceId,
            'COMPLETE_STEP_2',
            { aiAgentName: aiAgentName || null },
            existingStep
        );

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

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

        await Session.findOneAndUpdate(
            { workspaceId },
            { $set: { onboardingStep: 3 } }
        ).catch(() => {});

        res.json({ success: true, onboarding: result.state });
    } catch (err) {
        console.error('[Onboarding Step2 Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/onboarding/step3
 * Save sector + vertical + modules. Completes onboarding.
 * Uses XState machine: step3 cannot be accessed before step2 completes.
 */
router.post('/step3', validate(Step3Schema), async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId || !workspaceId) {
            return res.status(401).json({ error: 'No workspace. Please complete registration first.' });
        }
        const { sector, vertical, modules } = req.validatedBody;

        // ── State Machine Transition ──────────────────────────────
        const session = await Session.findOne({ workspaceId }).lean().catch(() => null);
        const existingStep = session?.onboardingStep || 1;

        const result = await advanceOnboarding(
            workspaceId,
            'COMPLETE_STEP_3',
            { sector, vertical, modules },
            existingStep
        );

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        // Persist workspace data
        const ws = await Workspace.findOneAndUpdate(
            { workspaceId },
            { $set: { sector, vertical, modules } },
            { new: true, upsert: false }
        );

        if (!ws) {
            return res.status(404).json({ error: 'Workspace not found' });
        }

        await Session.findOneAndUpdate(
            { workspaceId },
            { $set: { onboardingStep: 4, sector, vertical } }
        ).catch(() => {});

        await AIConfig.findOneAndUpdate(
            { workspaceId },
            { $set: { sector, vertical } },
            { upsert: false }
        ).catch(() => {});

        res.json({
            success: true,
            workspace: {
                workspaceId: ws.workspaceId,
                name: ws.name,
                sector: ws.sector,
                vertical: ws.vertical,
                modules: ws.modules,
            },
            onboarding: result.state,
        });
    } catch (err) {
        console.error('[Onboarding Step3 Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/onboarding/status
 * Get current workspace onboarding progress.
 * Uses XState machine state for accurate progress tracking.
 */
router.get('/status', async (req, res) => {
    try {
        const { userId, workspaceId } = req;
        if (!userId) {
            return res.json({ onboardingStep: 0, workspaceConfigured: false });
        }

        const ws = await Workspace.findOne({ workspaceId }).lean();
        if (!ws) {
            return res.json({ onboardingStep: 0, workspaceConfigured: false });
        }

        const user = await User.findOne({ clientId: userId }).lean();
        const session = await Session.findOne({ workspaceId }).lean().catch(() => null);

        // Get XState machine state for richer onboarding info
        const existingStep = session?.onboardingStep || (ws.sector ? 4 : 1);
        const actor = getOnboardingActor(workspaceId, existingStep);
        const machineState = getOnboardingState(actor.getSnapshot());

        res.json({
            onboardingStep: machineState.currentStep,
            progress: machineState.progress,
            state: machineState.state,
            completedSteps: machineState.completedSteps,
            canGoBack: machineState.canGoBack,
            isComplete: machineState.isComplete,
            workspaceConfigured: !!(ws.sector && ws.vertical),
            sector: ws.sector || null,
            vertical: ws.vertical || null,
            modules: ws.modules || [],
            workspaceName: ws.name,
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
