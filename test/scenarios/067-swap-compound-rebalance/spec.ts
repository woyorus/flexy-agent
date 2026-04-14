/**
 * Scenario 067 — emergency ingredient swap, compound swap + rebalance.
 *
 * Plan 033 / design doc 006 Screen 2. User says one message that
 * carries TWO swaps AND lands the macros far enough from target that
 * the agent rebalances a pantry staple to close the gap. The delta
 * block must show both Swapped lines and the Rebalanced line.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('067');
const batches = buildSwapBatches('067', session.id);

export default defineScenario({
  name: '067-swap-compound-rebalance',
  description:
    'Proposal 006 Screen 2: a single message carries two ingredient swaps on the tagine; the combined macro ' +
    'drift exceeds the noise band so the agent rebalances olive oil to close the gap. Delta block shows ' +
    'both Swapped lines plus a Rebalanced line. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  // Match design doc 006 Screen 2 verbatim: a compound pantry-staple
  // swap (wine + passata → stock + cherry tomatoes). Both substitutes
  // are pantry/produce, so all three auto-apply conditions hold for
  // each. The agent should auto-apply with a rebalance line.
  events: [
    text('no white wine and no passata — use beef stock and cherry tomatoes instead'),
  ],
});
