/**
 * Scenario 008 — flex move at the horizon edge via re-proposer.
 *
 * Plan 025 rework: the user types a flex move to Saturday dinner directly
 * in the proposal phase. The re-proposer handles the rearrangement,
 * including any cross-horizon considerations at the horizon edge.
 */
import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '008-rolling-flex-move-at-edge',
  description: 'Flex move to Saturday dinner via re-proposer — tests edge-day handling',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // User types flex move directly — no swap button needed.
    // Sunday = last day of horizon = true edge case for the re-proposer.
    text('Move the flex meal to Sunday dinner'),
    click('plan_approve'),
  ],
});
