/**
 * Scenario 039 — dispatcher return_to_flow during planning.
 *
 * Plan 028 (Plan C). The state-preservation regression test: a side
 * conversation mid-planning does NOT clobber planFlow, and the user can
 * return via natural language.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (proposal rendered)
 *   5. Type "what's the weather today?" — dispatcher picks out_of_scope,
 *      planFlow stays at phase === 'proposal'.
 *   6. Type "ok back to the plan" — dispatcher picks return_to_flow, the
 *      handler re-renders the proposal from planFlow.proposalText.
 *   7. Tap plan_approve.
 *
 * Assertions (from captured outputs):
 *   - Step 5's reply is a short out_of_scope decline + the inline
 *     [← Back to planning] button (plan_resume callback).
 *   - Step 6's reply is the stored proposalText with the planProposalKeyboard.
 *   - Step 7 confirms the plan successfully.
 *   - finalSession.planFlow === null (confirmed).
 *   - finalSession.recentTurns contains four entries:
 *       1. user "what's the weather today?"
 *       2. bot "<decline text>"          (wrapped-sink capture, out_of_scope)
 *       3. user "ok back to the plan"
 *       4. bot "<proposalText head>"      (wrapped-sink capture, return_to_flow)
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '039-dispatcher-return-to-flow',
  description:
    'Side question during planning proposal phase routes to out_of_scope; "ok back to the plan" routes to return_to_flow and re-renders the proposal. planFlow survives the side trip.',
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
    text("what's the weather today?"),
    text('ok back to the plan'),
    click('plan_approve'),
  ],
});
