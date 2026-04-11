/**
 * Scenario 038 — dispatcher out_of_scope decline.
 *
 * Plan 028 (Plan C). Verifies that the dispatcher correctly declines an
 * out-of-domain message with a short, specific, lifecycle-aware reply.
 *
 * Sequence:
 *   1. /start (no plan yet)
 *   2. Type "what's the weather today?"
 *
 * Expected: dispatcher picks out_of_scope with category="weather" and a
 * response that mentions meal planning and offers the menu.
 *
 * finalSession.recentTurns should contain one user turn and one bot turn
 * (the dispatcher's decline).
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '038-dispatcher-out-of-scope',
  description:
    'Dispatcher declines an out-of-domain request with out_of_scope and offers the menu. No downstream LLM calls.',
  clock: '2026-04-10T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text("what's the weather today?"),
  ],
});
