/**
 * Scenario 073 — "undo" reverses only the most recent swap.
 *
 * Plan 033 / design doc 006 Reversal §1. Seeded batch carries a
 * `swapHistory` with TWO prior records (wine→stock then passata→cherry
 * tomatoes). User types "undo". The agent reverses ONLY the most
 * recent (passata→cherry) record — passata returns, cherry tomatoes
 * leave, and the wine→stock swap stays.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildBatchWithSwapHistory, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('073');
const batch = buildBatchWithSwapHistory('073', session.id);

export default defineScenario({
  name: '073-swap-undo-most-recent',
  description:
    'Proposal 006 Reversal §1: "undo" reverses only the most recent SwapRecord; prior swaps stay. Plan 033.',
  clock: '2026-04-08T18:30:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches: [batch],
  },
  events: [text('undo the last swap on the beef tagine')],
});
