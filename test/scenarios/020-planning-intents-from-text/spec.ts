/**
 * Scenario 020 — free-text intents during planning (plan 019).
 *
 * Exercises three intents that previously hit the generic fallback:
 *
 * 1. **Swap from proposal phase.** The user sees the plan and types a swap
 *    request without tapping [Swap something]. The system routes it through
 *    the swap classifier and executes the change.
 *
 * 2. **"Start over" intent.** After the swap lands, the user decides the
 *    plan is no good and types "start over." The system resets the flow
 *    and restarts planning from the beginning (breakfast confirmation).
 *
 * 3. **Approve on second attempt.** After restarting, the user completes
 *    a fresh plan and approves it, proving the reset was clean.
 *
 * These three steps chain into one coherent user story: try the plan,
 * tweak it, give up, start over, approve. The transcript captures the
 * exact boundary where the old code would have replied with the generic
 * fallback and the new code understands the intent.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '020-planning-intents-from-text',
  description:
    'Swap from proposal phase (no button tap), start over mid-flow, ' +
    'then approve on second attempt. Plan 019 intents.',
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
    // ── Intent 1: Swap from proposal phase ──
    // Plan is on screen with [Looks good] [Swap something].
    // Instead of tapping [Swap something], user types a swap request directly.
    text("Put the flex meal on Sunday instead"),
    // Handle any gaps that emerged from the flex_move, then skip them.
    click('plan_skip_gap_0'),
    click('plan_skip_gap_1'),
    click('plan_skip_gap_2'),
    // ── Intent 2: Start over ──
    // User doesn't like the plan after the swap. Types "start over."
    text('Start over'),
    // We're back at breakfast confirmation. Complete the plan normally.
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
