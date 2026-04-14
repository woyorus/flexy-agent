/**
 * Scenario 071 — multi-batch ambiguity, commit with "both".
 *
 * Plan 033 / design doc 006 Screen 6. Chicken is in TWO active batches
 * (lunch Mon–Wed and dinner Thu–Fri). User says "use tofu instead of
 * chicken everywhere". The applier runs the agent once per candidate
 * in parallel at preview time, stashes a PendingSwapMultiBatch, and
 * surfaces an aggregate preview. The user then types "both" — the
 * pre-filter commits every candidate with zero additional LLM calls.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildMultiBatchChickenSession } from '../_swap-seeds.js';

const { session, batches } = buildMultiBatchChickenSession('071');

export default defineScenario({
  name: '071-swap-ambiguous-multi-batch',
  description:
    'Proposal 006 Screen 6: chicken → tofu across two active batches; applier returns multi-batch preview; ' +
    '"both" pre-filter commits both candidates; every batch now has tofu; swapHistory on each. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text('use tofu instead of chicken everywhere'),
    text('both'),
  ],
});
