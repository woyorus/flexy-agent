/**
 * Scenario 023 — add event during proposal review via re-proposer.
 *
 * The user sees the initial proposal, then says "oh wait, I have dinner
 * with friends on Friday." The re-proposer adds the event and rearranges
 * batches around it. The change summary shows the event addition and
 * any batch moves. The user approves.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '023-reproposer-event-add',
  description:
    'User adds an event mid-review — re-proposer adds event and rearranges batches.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // Initial proposal shown. User realizes they have plans Friday.
    text('Oh wait, I have dinner with friends on Friday, about 900 calories'),
    click('plan_approve'),
  ],
});
