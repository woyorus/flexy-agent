/**
 * Scenario 078 — unknown substitute triggers preview + confirm.
 *
 * Plan 033 / design doc 006 Edge — unknown substitute. User proposes
 * a substitute the agent can't confidently estimate macros for
 * ("pickled wild garlic"). Agent returns kind='preview' with
 * reason='unknown_substitute', stating the macro assumption. User
 * confirms with "go ahead" — pre-filter commits.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSwapBatches, buildSwapSession } from '../_swap-seeds.js';

const session = buildSwapSession('078');
const batches = buildSwapBatches('078', session.id);

export default defineScenario({
  name: '078-swap-unknown-substitute-preview',
  description:
    'Proposal 006 Edge "unknown substitute": swap to a novel ingredient previews with reason=unknown_substitute; ' +
    '"go ahead" pre-filter commits. Plan 033.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text("instead of parsley, use my grandma's pickled wild garlic"),
    text('go ahead'),
  ],
});
