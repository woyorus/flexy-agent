/**
 * Scenario 076 — swap on a batch whose cook days are all in the past.
 *
 * Plan 033 / design doc 006 Edge — past batch. Seeded batch has
 * eatingDays 2026-04-06/07/08; clock is 2026-04-10 so every day is
 * strictly past. User types "no white wine, use stock instead". The
 * applier returns hard_no with the verbatim "That batch is already
 * done" message + routing hint 'library_edit'. No persistence; no
 * pendingSwap.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildPastBatchSession } from '../_swap-seeds.js';

const { session, batches } = buildPastBatchSession('076');

export default defineScenario({
  name: '076-swap-batch-already-consumed',
  description:
    'Proposal 006 Edge "past batch": swap on a fully-past batch returns hard_no with the verbatim message ' +
    'and routing_hint=library_edit. Plan 033.',
  clock: '2026-04-10T09:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('no white wine, use beef stock instead')],
});
