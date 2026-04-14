/**
 * Scenario 074 — reset to original clears all overrides.
 *
 * Plan 033 / design doc 006 Reversal §3. Seeded batch carries 2 swap
 * records + a nameOverride. User types "reset to original". The agent
 * emits resetToOriginal=true; the applier re-runs the recipe scaler,
 * writes the fresh amounts, and clears nameOverride/bodyOverride and
 * swapHistory. A recipe-scaling call fires in the exec trace.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildBatchWithSwapHistory, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('074');
const batch = buildBatchWithSwapHistory('074', session.id);

export default defineScenario({
  name: '074-swap-reset-to-original',
  description:
    'Proposal 006 Reversal §3: "reset to original" clears nameOverride, bodyOverride, swapHistory; ' +
    'applier re-runs scaleRecipe; final batch matches library macros. Plan 033.',
  clock: '2026-04-08T19:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches: [batch],
  },
  events: [text('reset the beef tagine back to the original library recipe')],
});
