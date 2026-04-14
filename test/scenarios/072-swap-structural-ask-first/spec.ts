/**
 * Scenario 072 — structural swap asks first.
 *
 * Plan 033 / design doc 006 Screen 7. User says "use tofu instead of
 * chicken breast" on a chicken-containing batch. The swap is
 * structural (main protein replacement with a ~30% portion bump),
 * so the agent returns kind='preview' with reason='structural'. User
 * says "go ahead" — the pre-filter confirms without a fresh LLM
 * dispatcher call.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('072');
const batches = buildSwapBatches('072', session.id);

export default defineScenario({
  name: '072-swap-structural-ask-first',
  description:
    'Proposal 006 Screen 7: structural swap (tofu for chicken breast) previews; "go ahead" pre-filter ' +
    'commits; final batch has tofu with a bumped portion. pendingSwap cleared. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text('use tofu instead of chicken breast in the lunch bowl'),
    text('go ahead'),
  ],
});
