/**
 * Scenario 002 — flex_move regression (the bug plan 005 fixed).
 *
 * Reproduces the failure mode that motivated the harness: a `flex_move`
 * swap dissolves a multi-day batch, orphans surface as recipe gaps, and
 * without the fix at `src/agents/plan-flow.ts:697-706` those gaps never
 * reach the user — the solver re-runs on a truncated plan and clamps meal
 * calories at the 1000-cal lunch cap.
 *
 * ## Event order is load-bearing
 *
 * Before the swap flow accepts free-text input, `plan_swap` MUST
 * transition the flow to `awaiting_swap`. Sending text while phase is
 * `proposal` makes the text handler silently drop the message (the
 * `session.planFlow.phase` checks in `src/telegram/core.ts` only match
 * specific phases). The event list below enforces the correct order.
 *
 * ## What the captured transcript locks in
 *
 * After `text('Move flex slot to Saturday')`, any orphan days that the
 * swap tail cannot re-home into adjacent batches become recipe gaps.
 * Those gaps MUST be surfaced as `planRecipeGapKeyboard` messages before
 * the final proposal. The `click('plan_skip_gap_*')` sequence picks a
 * database recipe for each gap and advances through them. The 005 fix is
 * what makes the gap-surfacing happen at all; if it regresses, the gap
 * prompts disappear from the transcript and `deepStrictEqual` fires on
 * the outputs diff at exactly that position.
 *
 * The exact number of gaps created by flex_move depends on the LLM's
 * original proposal shape — the plan doc described 3 gaps (a Fri-Sun
 * batch dissolving when Saturday became the flex), but with the actual
 * six-balanced recipes the proposer's output yields a different layout
 * and the recorded transcript has 1 gap prompt surfacing. Extra
 * `plan_skip_gap_*` clicks past that count are handled as idempotent
 * no-ops by `handleGapResponse` (the pendingGaps lookup returns
 * undefined and the flow just re-renders the plan) so the skip chain is
 * safe to leave slightly longer than the minimum. The regression value
 * is unchanged: reverting `src/agents/plan-flow.ts:697-706` removes the
 * single gap prompt from output[6] and the captured diff catches it.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '002-plan-week-flex-move-regression',
  description:
    'flex_move swap dissolves a multi-day batch, orphans surface as recipe gaps, ' +
    'user skips each gap. Regression lock on plan 005 fix at plan-flow.ts:697-706.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Initial proposal arrives. Tap "Swap something" to enter swap flow.
    click('plan_swap'),
    // The nano classifier parses this as flex_move. Swap logic may create
    // orphan days that become recipe gaps.
    text('Move flex slot to Saturday'),
    // Skip each gap (pick from existing recipes). The plan 005 fix is
    // what routes the proposal through the gap-resolution sub-flow
    // instead of silently showing a broken proposal with the flex slot
    // already moved. Numbered indices (_0, _1, _2) reflect the
    // `advanceGapOrPresent` counter increment at plan-flow.ts:815-818.
    click('plan_skip_gap_0'),
    click('plan_skip_gap_1'),
    click('plan_skip_gap_2'),
    click('plan_approve'),
  ],
});
