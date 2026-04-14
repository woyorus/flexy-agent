/**
 * Scenario 066 — emergency ingredient swap, simple auto-apply path.
 *
 * Plan 033 / design doc 006 Screen 1. Active confirmed plan; user is
 * mid-week and types "no white wine, use beef stock instead" (no surface
 * pre-seeded — the dispatcher resolves via the PLAN SUMMARY ingredient
 * signature since "white wine" appears in exactly one active batch, the
 * tagine). The applier invokes the ingredient-swap agent, which auto-
 * applies (unambiguous target, named-and-common substitute, non-
 * structural). A `SwapRecord` appends to `batch.swapHistory`; the cook
 * view reply carries a delta block.
 *
 * Seed: canonical four-batch plan from `_swap-seeds.ts`; tagine batch
 *   carries `dry white wine` 60ml in its scaledIngredients.
 * Clock: 2026-04-07T17:00:00Z.
 * Sequence:
 *   1. text("no white wine, use beef stock instead")
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('066');
const batches = buildSwapBatches('066', session.id);

export default defineScenario({
  name: '066-swap-simple-auto-apply',
  description:
    'Proposal 006 Screen 1: "no white wine, use beef stock instead" routes to swap_ingredient; ' +
    'the agent auto-applies (unambiguous target + named substitute); the cook-view reply carries a ' +
    'delta block; batch.swapHistory gains one SwapRecord. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('no white wine, use beef stock instead')],
});
