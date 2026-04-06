/**
 * Scenario 001 — plan week happy path.
 *
 * Exercises the simplest full planning flow end-to-end:
 *   1. /start → main menu.
 *   2. Tap "📋 Plan Week" (reply-keyboard button, arrives as text).
 *   3. Keep the default breakfast.
 *   4. Report no events.
 *   5. Approve the proposal on first try.
 *
 * Fresh user (empty initial state), realistic six-balanced recipe set.
 * Validates both the inline-callback path and the reply-keyboard-text path
 * in a single run. If the proposer emits recipe gaps at generate time, the
 * recording captures whatever came back — the scenario still asserts on a
 * stable transcript afterward.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '001-plan-week-happy-path',
  description: 'Fresh user plans a week with six-balanced recipes and approves the first proposal',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    // "📋 Plan Week" is a reply-keyboard button (src/telegram/keyboards.ts:33),
    // so it arrives as a text message and is routed through matchMainMenu at
    // src/telegram/core.ts. NOT a callback — use text(), not click().
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
