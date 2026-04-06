/**
 * Scenario 014 — proposer orphan fill.
 *
 * Tests the deterministic orphan fill (Plan 011). After generating fixtures,
 * the recorded LLM response is manually edited to simulate the proposer
 * underfilling the week — removing days from batches to create orphan slots.
 * The fillOrphanSlots post-processing should extend adjacent batches to
 * cover the orphans, producing a valid plan with no "no source" errors.
 *
 * Uses the six-balanced recipe set (enough batches with spare capacity).
 * Fresh user, no events, standard happy-path flow.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '014-proposer-orphan-fill',
  description: 'Proposer underfills the week; deterministic orphan fill extends adjacent batches to cover gaps',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('\u{1F4CB} Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
