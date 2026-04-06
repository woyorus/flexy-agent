/**
 * Scenario 008 — flex move at the horizon edge.
 *
 * The original bug scenario (Plan 005) in the new rolling model. The user
 * plans a week, then moves the flex slot to Saturday dinner. With the
 * cross-horizon extension in Phase 5d, the carved orphan should be absorbed
 * or surface as a gap — no 1-serving silent dissolution.
 */
import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '008-rolling-flex-move-at-edge',
  description: 'Flex move to Saturday dinner — tests edge-day orphan handling',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_swap'),
    text('Move the flex meal to Saturday dinner'),
    click('plan_approve'),
  ],
});
