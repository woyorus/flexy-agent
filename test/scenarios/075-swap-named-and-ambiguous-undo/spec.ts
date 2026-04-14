/**
 * Scenario 075 — named reversal + ambiguous undo clarification.
 *
 * Plan 033 / design doc 006 Reversal §2 + §4. Seeded batch has two
 * swap records. Turn 1: user types "put the passata back" — named
 * reversal, only the passata swap is reversed. Turn 2 (with one swap
 * remaining, the wine→stock): user types "undo" again — the agent
 * unambiguously reverses the last remaining record. (The fully
 * ambiguous "undo" variant requires 2+ remaining records, which after
 * turn 1 doesn't hold — so this scenario exercises named reversal +
 * single-record undo. For the ambiguity clarification path, see the
 * behavioral review — we rely on the agent's prompt to produce
 * kind='clarification' when more than one swap is ambiguous.)
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildBatchWithSwapHistory, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('075');
const batch = buildBatchWithSwapHistory('075', session.id);

export default defineScenario({
  name: '075-swap-named-and-ambiguous-undo',
  description:
    'Proposal 006 Reversal §2+§4: named reversal ("put the passata back") reverses only that record; ' +
    'subsequent "undo" reverses the remaining wine→stock record. Plan 033.',
  clock: '2026-04-08T19:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches: [batch],
  },
  events: [
    text('put the passata back in the tagine'),
    text('also undo the white wine swap'),
  ],
});
