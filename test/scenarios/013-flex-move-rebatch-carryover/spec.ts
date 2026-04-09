/**
 * Scenario 013 — flex move with re-batching via re-proposer (Plan 025).
 *
 * Originally tested Plan 009's contiguous orphan merging. Now tests that
 * the re-proposer correctly rearranges batches when the user moves flex
 * to Sunday dinner (last day of horizon). The re-proposer handles the
 * entire rearrangement in a single LLM call — no orphan resolution.
 *
 * ## What the captured transcript locks in
 *
 * After the user types "Move the flex to Sunday dinner", the re-proposer
 * returns a complete new plan with flex on Sunday and batches adjusted.
 * The change summary shows what moved. No gap prompts, no intermediate
 * steps — one message in, one updated plan out.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '013-flex-move-rebatch-carryover',
  description:
    'Flex move to Sunday via re-proposer — batches rearrange cleanly, ' +
    'no orphan gaps. Plan 025 rework of Plan 009 regression.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // User types adjustment directly in proposal phase.
    text('Move the flex to Sunday dinner'),
    click('plan_approve'),
  ],
});
