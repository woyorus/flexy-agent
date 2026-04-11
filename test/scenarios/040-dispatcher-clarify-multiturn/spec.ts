/**
 * Scenario 040 — dispatcher clarify multi-turn.
 *
 * Plan 028 (Plan C). Exercises the clarify → user answers → dispatch again
 * path. Verifies recentTurns carries the clarification context into turn 2
 * so the dispatcher can resolve.
 *
 * Sequence:
 *   1. /start (no plan)
 *   2. Type "hmm" — dispatcher picks clarify with a "what would you like
 *      to do?" question.
 *   3. Type "I want to plan a week" — dispatcher picks clarify again (or
 *      out_of_scope — neither show_plan nor mutate_plan exist) with an
 *      honest "Tap 📋 Plan Week to start" reply.
 *
 * The test verifies that (a) both turns produce dispatcher fixtures, (b)
 * the second dispatcher call sees turn 1's bot response in its recent-turns
 * context, (c) neither turn mutates planFlow / recipeFlow / progressFlow,
 * (d) recentTurns has all 4 entries (2 user + 2 bot).
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '040-dispatcher-clarify-multiturn',
  description:
    'Dispatcher clarify with a follow-up turn; recentTurns carries the clarification into the second dispatch.',
  clock: '2026-04-10T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('hmm'),
    text('I want to plan a week'),
  ],
});
