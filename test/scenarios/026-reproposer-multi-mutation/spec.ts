/**
 * Scenario 026 — two sequential mutations via re-proposer.
 *
 * The user makes two changes in a row: first moves flex, then swaps a
 * recipe. Tests that mutation history accumulates correctly — the second
 * re-proposer call sees the first mutation in history and doesn't undo it.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '026-reproposer-multi-mutation',
  description:
    'Two sequential mutations — flex move then recipe swap. History preserves first change.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Mutation 1: move flex
    text('Put the flex on Thursday dinner'),
    // Mutation 2: swap a recipe (the first mutation should be preserved)
    text('Swap the tagine for the pork bowls'),
    click('plan_approve'),
  ],
});
