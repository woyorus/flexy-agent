/**
 * Scenario 002 — flex move via re-proposer (Plan 025).
 *
 * Originally tested deterministic flex_move orphan resolution (Plan 005).
 * Reworked for Plan 025: the user types a flex move request directly in
 * the proposal phase, and the re-proposer handles the entire rearrangement
 * in a single LLM call. No separate swap phase, no gap resolution flow.
 *
 * ## What the captured transcript locks in
 *
 * The user sees the initial proposal (flex on Saturday dinner) and types
 * "Move flex to Sunday dinner." The re-proposer returns a new complete plan
 * with flex on Sunday and batches rearranged. The change summary shows
 * what moved. The user approves.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '002-plan-week-flex-move-regression',
  description:
    'Flex move via re-proposer — user types "move flex to Sunday", ' +
    'plan rearranges in one LLM call. Plan 025 rework of Plan 005 regression.',
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
    // Initial proposal arrives (flex placement varies by LLM).
    // User types adjustment directly — no "Swap something" button needed.
    // Wednesday is mid-week, unlikely to be the proposer's first choice.
    text('Move the flex to Wednesday dinner'),
    click('plan_approve'),
  ],
});
