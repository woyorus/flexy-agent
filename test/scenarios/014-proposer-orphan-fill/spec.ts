/**
 * Scenario 014 — proposer validator retry.
 *
 * Plan 024: reworked from orphan-fill to validator-retry.
 * Tests the validateProposal() retry loop. After generating fixtures,
 * the recorded LLM response is manually edited to create an uncovered slot.
 * The validator catches the error and the proposer retries with the
 * errors fed back to the LLM. The retry fixture provides a valid plan.
 *
 * Uses the six-balanced recipe set. Fresh user, no events, standard flow.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '014-proposer-orphan-fill',
  description: 'Proposer returns incomplete plan; validator catches it and retry succeeds',
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
