/**
 * Scenario 079 — unit conversion that implies a structural scale shift.
 *
 * Plan 033 / design doc 006 Edge — different units. User bought two
 * 10-oz salmon fillets (~566g) when the recipe wants 300g for 2
 * servings. The 2x overshoot is a structural scale shift, not a
 * simple unit conversion. Agent previews with the two-option text
 * (scale to 4 servings vs keep 2 with bigger portions). User picks
 * "scale to 4 servings" — the batch persists with bumped portions.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import { buildSalmonSession } from '../_swap-seeds.js';

const { session, batches } = buildSalmonSession('079');

export default defineScenario({
  name: '079-swap-unit-conversion-scale-shift',
  description:
    'Proposal 006 Edge "different units → structural scale shift": two 10-oz fillets ~= 566g; agent ' +
    'previews; user picks a resolution. Plan 033.',
  clock: '2026-04-09T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [session],
    batches,
  },
  events: [
    text('I grabbed two 10-oz salmon fillets, that\'s all they had'),
    text('go ahead'),
  ],
});
