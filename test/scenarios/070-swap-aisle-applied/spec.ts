/**
 * Scenario 070 — grocery-aisle applied swap (Screen 5).
 *
 * Plan 033 / design doc 006 Screen 5. User is at the store, already
 * past the help-me-pick, and says "got the cod, 320g for 2 servings".
 * The applier binds to the salmon batch (single candidate), the agent
 * auto-applies with a rename, and the cook view reflects cod.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSalmonSession } from '../_swap-seeds.js';

const { session, batches } = buildSalmonSession('070');

export default defineScenario({
  name: '070-swap-aisle-applied',
  description:
    'Proposal 006 Screen 5: in-aisle follow-up "got the cod, 320g" binds to the unique salmon batch and ' +
    'auto-applies with a rename; persisted batch scaledIngredients has cod instead of salmon. Plan 033.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('got cod instead of the salmon, 320g for 2 servings')],
});
