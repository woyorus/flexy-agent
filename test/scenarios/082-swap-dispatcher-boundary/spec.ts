/**
 * Scenario 082 — dispatcher boundary between swap_ingredient and
 * mutate_plan. Two turns test the prompt-drift risk.
 *
 * Plan 033 Phase 3.2 boundary rules. Turn 1: "swap tomorrow's dinner
 * for something lighter" — recipe-level swap, dispatcher picks
 * mutate_plan. Turn 2: "no white wine, use beef stock" — ingredient-
 * level, dispatcher picks swap_ingredient.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('082');
const batches = buildSwapBatches('082', session.id);

export default defineScenario({
  name: '082-swap-dispatcher-boundary',
  description:
    'Plan 033: dispatcher boundary pin — recipe-level swap → mutate_plan; ingredient-level → swap_ingredient. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text("swap tomorrow's dinner for something lighter"),
    text('no white wine, use beef stock'),
  ],
});
