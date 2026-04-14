/**
 * Scenario 068 — emergency swap: two removals, acknowledgment rule.
 *
 * Plan 033 / design doc 006 Screen 3. User removes TWO ingredients in
 * one message. One is caloric enough to trigger a rebalance; the other
 * is not. The delta block must acknowledge BOTH removals — the
 * "acknowledgment rule" says users see every change they named.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('068');
const batches = buildSwapBatches('068', session.id);

export default defineScenario({
  name: '068-swap-removal-acknowledgment',
  description:
    'Proposal 006 Screen 3: two removals in one message — raisins (caloric) and parsley (trivial). ' +
    'Both removals land in scaledIngredients AND both are named in the delta block. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('skip the raisins, I ran out — also no parsley')],
});
