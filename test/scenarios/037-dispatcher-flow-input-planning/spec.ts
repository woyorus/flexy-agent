/**
 * Scenario 037 — dispatcher picks flow_input during planning proposal phase.
 *
 * Plan 028 (Plan C). Verifies that the dispatcher correctly classifies
 * mutation text during an active planning flow as flow_input, forwards to
 * the existing re-proposer path, and preserves planFlow state + grows
 * recentTurns.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week (lifecycle: no_plan → planning)
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events
 *   5. (plan-proposer runs, proposal rendered)
 *   6. Type "Move the flex to Sunday" — dispatcher picks flow_input, routes
 *      to handleMutationText, re-proposer regenerates, diff rendered.
 *   7. Tap plan_approve
 *
 * Assertions come from the recorded outputs (rendered plan with flex on
 * Sunday) and finalSession.planFlow === null (confirmed). recentTurns
 * should contain one user turn ("Move the flex to Sunday") followed by
 * one bot turn whose text is the head of the re-proposer's substantive
 * reply (the diff + new proposal text, truncated to BOT_TURN_TEXT_MAX).
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '037-dispatcher-flow-input-planning',
  description:
    'Dispatcher routes mutation text during planning proposal phase to flow_input → re-proposer. Validates state preservation and recentTurns bookkeeping.',
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
    text('Move the flex to Sunday'),
    click('plan_approve'),
  ],
});
