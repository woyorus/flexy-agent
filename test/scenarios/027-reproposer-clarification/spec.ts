/**
 * Scenario 027 — re-proposer clarification round-trip.
 *
 * The user sends a vague message with no actionable content ("this doesn't
 * work for me"). The re-proposer can't confidently rearrange anything, so
 * it returns a clarification question. The user then gives a specific
 * answer ("move the flex to Friday"). The re-proposer produces the updated
 * plan. Tests the pendingClarification state machine.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '027-reproposer-clarification',
  description:
    'Vague request triggers clarification — user clarifies, plan updates.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Vague: no actionable content for the re-proposer.
    text("this doesn't work for me"),
    // Re-proposer should ask what to change. User gives a specific answer.
    text('put the flex on Wednesday dinner instead'),
    click('plan_approve'),
  ],
});
