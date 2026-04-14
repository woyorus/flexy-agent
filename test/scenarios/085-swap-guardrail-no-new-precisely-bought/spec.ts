/**
 * Scenario 085 — guardrail: agent introduces a NEW precisely-bought
 * ingredient the user didn't name. Fixture-edited.
 *
 * Plan 033 / design doc 006 § "introducing a new precisely-bought
 * ingredient… is a hard no". The LLM response (after fixture edit)
 * adds "pine nuts 30g" as a replacement — the user never mentioned
 * pine nuts. The guardrail rejects with hard_no; the batch is
 * unchanged.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('085');
const batches = buildSwapBatches('085', session.id);

export default defineScenario({
  name: '085-swap-guardrail-no-new-precisely-bought',
  description:
    'Plan 033 guardrail: fixture-edited LLM adds pine nuts the user did not name; applier rejects. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('no raisins, use something else')],
});
