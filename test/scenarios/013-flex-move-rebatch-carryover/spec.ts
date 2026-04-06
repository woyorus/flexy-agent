/**
 * Scenario 013 — flex_move re-batching + horizon-edge carry-over (Plan 009).
 *
 * Exercises the core Plan 009 fix: when a flex_move dissolves a multi-day
 * batch, contiguous orphans merge into a multi-serving batch reusing the
 * dissolved recipe — no 1-serving gaps. If the merge lands near the horizon
 * edge, overflow days extend silently into the next week.
 *
 * ## What the captured transcript locks in
 *
 * After `text('Move the flex to Sunday dinner')`, the carved batch's orphan
 * days must merge into a 2+ serving batch (not individual 1-serving gaps).
 * The plan should go directly to the proposal view — no gap prompts for
 * merged orphans. Any gap prompts indicate the merging failed.
 *
 * Key assertions in the recording:
 * - No 1-serving meal-prep batches in any plan proposal
 * - Dissolved recipe reused for the merged orphan batch
 * - If a merged batch sits at the horizon edge, carry-over notation present
 * - Plan approval succeeds without intermediate gap resolution
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '013-flex-move-rebatch-carryover',
  description:
    'flex_move dissolves a multi-day batch — contiguous orphans merge ' +
    'into a multi-serving batch with dissolved recipe, no 1-serving gaps.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Initial proposal arrives. Tap "Swap something" to enter swap flow.
    click('plan_swap'),
    // Move flex to Sunday dinner — last day of horizon. The dinner batch
    // covering Sunday dissolves, orphans should merge with the freed flex day.
    text('Move the flex to Sunday dinner'),
    // Plan 009 fix: orphans merged, no gap prompts. Approve directly.
    click('plan_approve'),
  ],
});
