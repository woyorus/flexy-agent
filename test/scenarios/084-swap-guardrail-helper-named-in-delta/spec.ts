/**
 * Scenario 084 — guardrail: helper in ingredients but missing from
 * delta_lines. Fixture-edited.
 *
 * Plan 033 / design doc 006 § "pantry-staple helper may be introduced…
 * always named openly in the delta". The LLM response (after fixture
 * edit) introduces "lemon juice 10ml" in `scaled_ingredients` but
 * OMITS it from `delta_lines`. The applier's defense-in-depth
 * regenerates the delta line from the changes array so the rendered
 * reply still mentions the helper.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('084');
const batches = buildSwapBatches('084', session.id);

export default defineScenario({
  name: '084-swap-guardrail-helper-named-in-delta',
  description:
    'Plan 033 guardrail: fixture-edited helper is missing from delta_lines; applier regenerates the delta. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('no white wine, use beef stock instead')],
});
