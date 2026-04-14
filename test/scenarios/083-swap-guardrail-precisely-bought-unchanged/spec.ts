/**
 * Scenario 083 — guardrail: agent tries to silently mutate a precisely-
 * bought ingredient the user did not name. Fixture-edited.
 *
 * Plan 033 / design doc 006 § "Untouched stays untouched". The user
 * asks for a wine→stock swap. The LLM response (after fixture edit)
 * ALSO shrinks ground beef from 200g→180g — an invariant violation.
 * The applier's post-agent guardrail validator rejects the swap with
 * hard_no. Seed batch's ground beef stays at 200g.
 *
 * Workflow (per CLAUDE.md):
 *   1. `npm run test:generate -- 083-swap-guardrail-precisely-bought-unchanged`
 *   2. Apply the edit described in fixture-edits.md
 *   3. `npm run test:replay -- 083-swap-guardrail-precisely-bought-unchanged`
 *   NEVER `--regenerate` after step 2.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('083');
const batches = buildSwapBatches('083', session.id);

export default defineScenario({
  name: '083-swap-guardrail-precisely-bought-unchanged',
  description:
    'Plan 033 guardrail: fixture-edited LLM response tries to silently reduce ground beef; applier rejects. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [text('no white wine, use beef stock instead')],
});
