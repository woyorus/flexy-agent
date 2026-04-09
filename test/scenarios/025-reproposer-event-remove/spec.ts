/**
 * Scenario 025 — remove event during proposal review via re-proposer.
 *
 * The user adds an event during event collection, sees the proposal with
 * the event baked in, then says "actually the Friday dinner got cancelled."
 * The re-proposer removes the event and fills the freed slot with a batch.
 *
 * Tests that the re-proposer can remove events and rearrange batches to
 * cover the freed slot.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '025-reproposer-event-remove',
  description:
    'User removes an event mid-review — re-proposer fills the freed slot.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    // Add a Friday dinner event during event collection.
    click('plan_add_event'),
    text('Dinner with coworkers on Friday, Italian place, about 900 cal'),
    click('plan_events_done'),
    // Proposal shown with the event. User cancels it.
    text('Actually the Friday dinner got cancelled, remove it'),
    click('plan_approve'),
  ],
});
