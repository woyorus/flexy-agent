/**
 * Scenario 080 — rewrite fallthrough + cancel pre-filter.
 *
 * Plan 033 / design doc 006 Phase 4.7 + 3.3. Three-turn dance:
 *   1. User previews a structural swap (tofu for chicken).
 *   2. User rewrites ("actually use chickpeas"). Pre-filter does NOT
 *      match — the message falls through to the dispatcher, which
 *      sees pendingSwap in context and routes to swap_ingredient
 *      again. Applier drops the prior pending and produces a fresh
 *      decision (either another preview or an apply).
 *   3. User types "nevermind" — pre-filter's cancel branch clears
 *      pendingSwap.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('080');
const batches = buildSwapBatches('080', session.id);

export default defineScenario({
  name: '080-swap-cancel-and-rewrite',
  description:
    'Plan 033: preview → rewrite (dispatcher fallthrough, fresh decision) → cancel (pre-filter clears). Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text('use tofu instead of chicken breast'),
    text('actually use chickpeas instead'),
    text('nevermind'),
  ],
});
