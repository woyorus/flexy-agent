/**
 * Scenario 043 — plan_resume back-button callback equivalence.
 *
 * Plan 028 (Plan C). Regression lock for proposal 003 invariant #7:
 * natural-language back commands and back-button taps must produce
 * identical bot output. Scenario 039 exercises the natural-language
 * path ("ok back to the plan" → dispatcher → return_to_flow →
 * handleReturnToFlowAction → rerenderPlanFlow → stored proposalText).
 * This scenario exercises the callback path (plan_resume click →
 * handleCallback → handleReturnToFlowAction → rerenderPlanFlow →
 * stored proposalText). Both paths converge on handleReturnToFlowAction,
 * so the output at step 6 must be byte-identical to scenario 039's
 * step 6 output.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (proposal rendered + stored on planFlow.proposalText)
 *   5. Type "what's the weather today?" — dispatcher picks out_of_scope,
 *      the reply carries an inline [← Back to planning] button.
 *   6. Click plan_resume  — handleCallback delegates to
 *      handleReturnToFlowAction, which calls rerenderPlanFlow, which
 *      emits the stored proposalText + planProposalKeyboard.
 *   7. Tap plan_approve.
 *
 * Assertions:
 *   - Step 5's reply is a short out_of_scope decline + the inline
 *     [← Back to planning] button (plan_resume callback).
 *   - Step 6's reply matches the stored proposalText from step 4.
 *   - NO dispatcher LLM fixture for step 6 — the callback path does not
 *     go through runDispatcherFrontDoor.
 *   - finalSession.planFlow === null (confirmed).
 *   - finalSession.recentTurns contains exactly THREE entries:
 *       1. user "what's the weather today?"
 *       2. bot "<out_of_scope decline head>" (from runDispatcherFrontDoor)
 *       3. bot "<proposalText head>"          (from the plan_resume callback)
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '043-dispatcher-plan-resume-callback',
  description:
    'plan_resume inline back-button re-renders the planning proposal via handleReturnToFlowAction delegation. Regression lock for proposal 003 invariant #7 (button-tap / natural-language equivalence).',
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
    click('plan_resume'),
    click('plan_approve'),
  ],
});
