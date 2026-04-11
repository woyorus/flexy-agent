/**
 * Scenario 041 — cancel-vs-return_to_flow precedence regression lock.
 *
 * Plan 028 (Plan C). The cancel phrase set and the dispatcher's
 * return_to_flow phrase set are disjoint, and the runner calls
 * matchPlanningMetaIntent BEFORE the dispatcher when a planning flow is
 * active. This scenario fails loudly if a future change accidentally
 * routes "nevermind" through the dispatcher.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (proposal rendered)
 *   5. Type "nevermind"  — must hit matchPlanningMetaIntent('cancel')
 *      BEFORE the dispatcher runs. No dispatcher fixture should appear
 *      for this turn. planFlow is cleared, surface returns to menu.
 *
 * Expected llmFixtures: only the plan-proposer fixture(s) from step 4.
 * No dispatcher fixture for the "nevermind" turn.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '041-dispatcher-cancel-precedence',
  description:
    'Cancel phrase short-circuits the dispatcher during active planning. No dispatcher fixture for the cancel turn.',
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
    text('nevermind'),
  ],
});
