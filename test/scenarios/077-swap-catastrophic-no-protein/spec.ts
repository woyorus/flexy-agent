/**
 * Scenario 077 — catastrophic identity-break swap.
 *
 * Plan 033 / design doc 006 Edge — recipe identity break. On the
 * creamy-salmon-and-shrimp-linguine batch, the user says "skip the
 * salmon AND the shrimp" — removing every protein leaves a pasta
 * dish with no identity. The agent returns kind='hard_no' with
 * routing_hint='recipe_level_swap'. Reply contains the "swap the
 * whole recipe" option from the proposal.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSalmonSession } from '../_swap-seeds.js';

const { session, batches } = buildSalmonSession('077');

export default defineScenario({
  name: '077-swap-catastrophic-no-protein',
  description:
    'Proposal 006 Edge "catastrophic identity break": skip both proteins on the salmon/shrimp pasta; ' +
    'agent returns hard_no with routing_hint=recipe_level_swap. Plan 033.',
  clock: '2026-04-09T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('skip the salmon AND the shrimp — what should I do?')],
});
