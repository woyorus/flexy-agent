/**
 * Scenario 024 — recipe swap via re-proposer.
 *
 * The user sees the initial proposal and asks to swap a specific recipe
 * for something different from the DB. The re-proposer picks a replacement
 * and may adjust days to respect fridge life. The change summary shows the
 * swap. The user approves.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '024-reproposer-recipe-swap',
  description:
    'User swaps a recipe — re-proposer picks replacement from DB.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    // User wants fish instead of beef.
    text('I want the salmon linguine instead of the beef bolognese'),
    click('plan_approve'),
  ],
});
