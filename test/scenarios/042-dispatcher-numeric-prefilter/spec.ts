/**
 * Scenario 042 — numeric pre-filter bypass + post-measurement dispatch.
 *
 * Plan 028 (Plan C). Verifies two behaviors:
 *   - Numeric input during awaiting_measurement is handled by the runner's
 *     tryNumericPreFilter before the dispatcher runs (no dispatcher fixture).
 *   - After the measurement is logged, the progressFlow is cleared, and
 *     any subsequent free text goes through the dispatcher normally.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📊 Progress (enters awaiting_measurement)
 *   3. Type "82.3"  — numeric pre-filter logs it, progressFlow cleared
 *   4. Type "how am I doing?"  — dispatcher picks clarify or out_of_scope
 *
 * Expected:
 *   - No dispatcher fixture for turn 3 (pre-filter short-circuits).
 *   - One dispatcher fixture for turn 4.
 *   - finalStore.measurements has one entry for today (82.3, null waist).
 *   - finalSession.progressFlow === null.
 *   - finalSession.recentTurns has two entries for turn 4: the user's
 *     "how am I doing?" and the dispatcher's reply. No entries for the
 *     numeric input — the pre-filter does not push turns.
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '042-dispatcher-numeric-prefilter',
  description:
    'Numeric pre-filter short-circuits dispatcher for awaiting_measurement; subsequent text dispatches normally.',
  clock: '2026-04-10T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('📊 Progress'),
    text('82.3'),
    text('how am I doing?'),
  ],
});
