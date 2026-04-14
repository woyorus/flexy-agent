/**
 * Scenario 069 — help-me-pick at the grocery store.
 *
 * Plan 033 / design doc 006 Screen 4. User is shopping and asks "they
 * don't have salmon, what should I get?". The applier resolves the
 * single salmon batch, invokes the agent in help-me-pick mode, and
 * returns 2–3 named options. NO persistence — the user hasn't picked
 * yet. The follow-up ("got the cod, 320g") lives in scenario 070.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSalmonSession } from '../_swap-seeds.js';

const { session, batches } = buildSalmonSession('069');

export default defineScenario({
  name: '069-swap-help-me-pick',
  description:
    'Proposal 006 Screen 4: "they don\'t have salmon, what should I get?" — applier resolves the ' +
    'unique salmon batch; agent returns help-me-pick with 2–3 options; batch is NOT persisted. Plan 033.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text("they don't have salmon, what should I get?")],
});
