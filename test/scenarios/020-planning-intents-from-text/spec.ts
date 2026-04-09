/**
 * Scenario 020 — free-text intents during planning (Plan 025).
 *
 * Exercises two intents in one coherent user story:
 *
 * 1. **Mutation from proposal phase.** The user sees the plan and types
 *    "Put the flex meal on Sunday instead." The re-proposer handles the
 *    rearrangement and shows a change summary.
 *
 * 2. **"Start over" intent.** After the mutation, the user types "start over."
 *    The system resets the flow and restarts planning from breakfast confirmation.
 *
 * 3. **Approve on second attempt.** After restarting, the user completes
 *    a fresh plan and approves it.
 *
 * Plan 025 rework: no "Swap something" button, no gap resolution flow.
 * All mutations go through the re-proposer directly.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '020-planning-intents-from-text',
  description:
    'Mutation from proposal phase (no button tap), start over mid-flow, ' +
    'then approve on second attempt. Plan 025 re-proposer flow.',
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
    // ── Intent 1: Mutation from proposal phase ──
    // Plan is on screen with [Looks good]. User types adjustment directly.
    text("Put the flex meal on Sunday instead"),
    // ── Intent 2: Start over ──
    // User doesn't like the plan. Types "start over."
    text('Start over'),
    // Back at breakfast confirmation. Complete the plan normally.
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
