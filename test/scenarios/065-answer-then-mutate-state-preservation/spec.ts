/**
 * Scenario 065 — cross-action state preservation regression lock.
 *
 * Plan 030 (Plan E). **The most complex scenario in Plan E.** The user
 * goes through the full planning flow to reach the proposal phase, asks a
 * side question ("when's my flex this week?"), then mutates the plan
 * ("actually move the flex to Sunday"), and finally approves. This is the
 * direct embodiment of proposal 003 state preservation invariant #1:
 * a side question during an active planning flow MUST NOT disturb the
 * planFlow state, and a subsequent mutation MUST operate on the preserved
 * flow.
 *
 * Sequence:
 *   1. /start — main menu
 *   2. Type "Plan Week" (reply keyboard) — enters planning flow
 *   3. Tap plan_keep_breakfast — keeps default breakfast
 *   4. Tap plan_no_events — no events this week
 *   5. (plan-proposer runs, proposal rendered with flex slot)
 *   6. Type "when's my flex this week?" — dispatcher picks
 *      answer_plan_question, replies inline with the answer. The planFlow
 *      is preserved at phase: 'proposal'.
 *   7. Type "actually move the flex to Sunday" — dispatcher picks
 *      mutate_plan, applier's in-session branch calls handleMutationText,
 *      re-proposer regenerates with flex on Sunday, diff rendered.
 *   8. Tap plan_approve — plan confirmed. The persisted session's
 *      mutationHistory has the "move flex to Sunday" entry.
 *
 * Clock: 2026-04-05T18:00:00Z (Saturday evening — planning for Mon Apr 6
 * to Sun Apr 12). Fresh user, no seeded plan.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '065-answer-then-mutate-state-preservation',
  description:
    'Cross-action state preservation: user reaches proposal phase, asks a side question ' +
    '(answer_plan_question), then mutates the plan (mutate_plan), then approves. ' +
    'Locks proposal 003 invariant #1: side questions preserve planFlow. Plan 030.',
  clock: '2026-04-05T18:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('\ud83d\udccb Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    text("when's my flex this week?"),
    text('actually move the flex to Sunday'),
    click('plan_approve'),
  ],
});
