/**
 * Scenario 021 — "cancel" intent exits the planning flow (plan 019).
 *
 * The user starts planning, reaches the proposal, and types "nevermind."
 * The system clears the plan flow and returns to the main menu — the user
 * is NOT planning anymore.
 *
 * Verifies that:
 * - `session.planFlow` is null after cancel
 * - `session.surfaceContext` is null (not stuck on 'plan')
 * - The reply is "Planning cancelled." with the main menu keyboard
 *
 * Distinct from "start over" (scenario 020) which restarts planning.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '021-planning-cancel-intent',
  description:
    'User types "nevermind" during proposal phase — planning exits cleanly to main menu.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Plan is on screen. User types "nevermind" to cancel.
    text('nevermind'),
  ],
});
