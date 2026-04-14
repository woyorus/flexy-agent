/**
 * Scenario 086 — breakfast swap full lifecycle.
 *
 * Plan 033 / Phase 9. Three-turn scenario exercising the breakfast
 * target (`target_batch_id='breakfast'`):
 *   1. "no yogurt, use cottage cheese instead" — auto-applies; creates
 *      `planSession.breakfastOverride` with cottage cheese.
 *   2. "actually use ricotta instead" — rewrite; updates the override,
 *      appending a second SwapRecord.
 *   3. "reset to original" — clears the override; plan session's
 *      breakfastOverride becomes undefined.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('086');
const batches = buildSwapBatches('086', session.id);

export default defineScenario({
  name: '086-swap-breakfast-full-lifecycle',
  description:
    'Plan 033 Phase 9: three-turn breakfast swap — apply, rewrite, reset. breakfastOverride materializes, ' +
    'updates, then clears. Plan 033.',
  clock: '2026-04-07T08:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text('no yogurt, use cottage cheese instead'),
    text('actually use ricotta instead'),
    text('reset to original'),
  ],
});
