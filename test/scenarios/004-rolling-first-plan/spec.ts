/**
 * Scenario 004 — first-ever plan from completely empty state.
 *
 * No prior sessions, no batches. computeNextHorizonStart falls back to
 * "tomorrow" (D6). Verifies the cold-start path works correctly.
 */
import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '004-rolling-first-plan',
  description: 'First-ever plan from empty state — horizonStart = tomorrow',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
