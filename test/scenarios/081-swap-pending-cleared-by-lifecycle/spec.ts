/**
 * Scenario 081 — pendingSwap cleared on lifecycle transitions.
 *
 * Plan 033 / design doc 006 Phase 4.6 state invariant. Turn 1
 * previews a structural swap (pendingSwap set). Turn 2 types /start
 * — BotCore resets the session and clears pendingSwap.
 *
 * This scenario covers the load-bearing invariant that pendingSwap
 * lifecycle-clears next to every pendingMutation clear — /start is
 * one of the most error-prone sites.
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('081');
const batches = buildSwapBatches('081', session.id);

export default defineScenario({
  name: '081-swap-pending-cleared-by-lifecycle',
  description:
    'Plan 033 invariant: pendingSwap is cleared by /start (one of ~14 lifecycle sites). Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text('use tofu instead of chicken breast'),
    command('start'),
  ],
});
