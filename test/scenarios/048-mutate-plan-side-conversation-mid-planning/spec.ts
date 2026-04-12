/**
 * Scenario 048 — side conversation mid-planning with mutation history preservation.
 *
 * Plan 029 (Plan D). State preservation test: the user starts a fresh
 * planning flow, reaches the proposal phase, types a mutation ("Move
 * the flex to Sunday"), then asks an off-topic question ("what's the
 * weather today?" — dispatcher picks out_of_scope, planFlow preserved),
 * then types another mutation ("Also swap the tagine for fish" —
 * dispatcher picks mutate_plan again, applier's in-session branch runs,
 * mutation history extends to 2 entries), and finally approves.
 *
 * The final persisted session's `mutationHistory` must contain BOTH
 * mutation records, proving that side conversations do not clobber
 * accumulated mutation state and that multiple in-session mutations
 * stack correctly.
 *
 * Clock: 2026-04-05T10:00:00Z (Saturday before the plan week).
 * No seeded plan — fresh planning flow.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (plan-proposer runs, proposal rendered)
 *   5. Type "Move the flex to Sunday" — dispatcher picks mutate_plan,
 *      in-session branch, re-proposer regenerates with flex on Sunday.
 *   6. Type "what's the weather today?" — dispatcher picks out_of_scope,
 *      planFlow preserved at phase === 'proposal'.
 *   7. Type "Also swap the tagine for fish" — dispatcher picks mutate_plan,
 *      in-session branch, re-proposer swaps recipe, mutation history now
 *      has 2 entries.
 *   8. Tap plan_approve — plan confirmed with both mutations in history.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '048-mutate-plan-side-conversation-mid-planning',
  description:
    'Side conversation mid-planning: mutation, off-topic question (planFlow preserved), second mutation, approve. ' +
    'Final mutationHistory has both entries. Plan 029 state preservation test.',
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
    text('Move the flex to Sunday'),
    text("what's the weather today?"),
    text('Also swap the tagine for fish'),
    click('plan_approve'),
  ],
});
