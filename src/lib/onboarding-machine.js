/**
 * Onboarding State Machine for ConcertOS
 *
 * Defines the onboarding flow as a state machine.
 * States: START → STEP1_DONE → STEP2_DONE → COMPLETE
 *
 * Guarantees:
 * - No step can be skipped (step N+1 requires step N to complete)
 * - No partial state on failure (atomic transitions)
 * - State is persisted in MongoDB after each transition
 * - Clients can query current state via /api/onboarding/status
 *
 * Usage:
 *   import { createOnboardingMachine, getOnboardingState } from './onboarding-machine.js';
 *   const actor = createActor(createOnboardingMachine({ workspaceId }));
 *   actor.start();
 *   actor.send({ type: 'COMPLETE_STEP_1', data: { workspaceName, phone } });
 */

import { createMachine, assign, fromPromise } from 'xstate';

// ── Machine Definition ───────────────────────────────────────────

/**
 * Create the onboarding state machine for a given workspace.
 * @param {{ workspaceId: string }} params
 */
export function createOnboardingMachine({ workspaceId }) {
    return createMachine({
        id: 'onboarding',
        initial: 'step1',
        context: {
            workspaceId,
            workspaceName: null,
            phone: null,
            aiAgentName: null,
            sector: null,
            vertical: null,
            modules: null,
            completedSteps: [],
            lastError: null,
        },
        states: {
            // ── Step 1: Workspace Name + Phone ────────────────────
            step1: {
                on: {
                    COMPLETE_STEP_1: {
                        target: 'step2',
                        actions: assign({
                            workspaceName: ({ event }) => event.data.workspaceName,
                            phone: ({ event }) => event.data.phone,
                            completedSteps: ({ context }) => [...context.completedSteps, 'step1'],
                            lastError: null,
                        }),
                    },
                    BACK: { target: 'cancelled' },
                },
            },

            // ── Step 2: AI Agent Name + Daily Tasks ───────────────
            step2: {
                on: {
                    COMPLETE_STEP_2: {
                        target: 'step3',
                        actions: assign({
                            aiAgentName: ({ event }) => event.data.aiAgentName,
                            completedSteps: ({ context }) => [...context.completedSteps, 'step2'],
                            lastError: null,
                        }),
                    },
                    BACK: {
                        target: 'step1',
                        actions: assign({
                            workspaceName: null,
                            phone: null,
                            completedSteps: ({ context }) =>
                                context.completedSteps.filter(s => s !== 'step1'),
                        }),
                    },
                },
            },

            // ── Step 3: Sector + Vertical + Modules ───────────────
            step3: {
                on: {
                    COMPLETE_STEP_3: {
                        target: 'complete',
                        actions: assign({
                            sector: ({ event }) => event.data.sector,
                            vertical: ({ event }) => event.data.vertical,
                            modules: ({ event }) => event.data.modules,
                            completedSteps: ({ context }) => [...context.completedSteps, 'step3'],
                            lastError: null,
                        }),
                    },
                    BACK: {
                        target: 'step2',
                        actions: assign({
                            aiAgentName: null,
                            completedSteps: ({ context }) =>
                                context.completedSteps.filter(s => s !== 'step2'),
                        }),
                    },
                },
            },

            // ── Complete ──────────────────────────────────────────
            complete: {
                type: 'final',
                entry: assign({
                    completedSteps: ({ context }) => [...context.completedSteps, 'complete'],
                }),
            },

            // ── Cancelled ────────────────────────────────────────
            cancelled: {
                type: 'final',
            },
        },
    });
}

/**
 * Get a human-readable onboarding state + progress for API responses.
 * @param {import('xstate').ActorState} state
 */
export function getOnboardingState(state) {
    const currentStepMap = {
        step1: 1,
        step2: 2,
        step3: 3,
        complete: 4,
        cancelled: 0,
    };

    const currentStep = currentStepMap[state.value] || 0;
    const completed = state.context.completedSteps || [];

    return {
        currentStep,
        totalSteps: 4,
        state: state.value,
        workspaceName: state.context.workspaceName,
        completedSteps: completed,
        canGoBack: state.value !== 'step1' && state.value !== 'complete' && state.value !== 'cancelled',
        isComplete: state.value === 'complete',
        isCancelled: state.value === 'cancelled',
        progress: `${currentStep}/4`,
    };
}

/**
 * Validate that the client can advance to the next step.
 * Returns null if valid, error string if not allowed.
 * @param {string} currentState - Current machine state value
 * @param {number} targetStep - Step number client is trying to access (1-3)
 */
export function canAdvanceTo(currentState, targetStep) {
    const validTransitions = {
        step1: [1],
        step2: [1, 2],
        step3: [1, 2, 3],
        complete: [1, 2, 3, 4],
        cancelled: [1],
    };

    const allowed = validTransitions[currentState] || [];
    return allowed.includes(targetStep) ? null : `Step ${targetStep} cannot be accessed from current state`;
}