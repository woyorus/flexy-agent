/**
 * Scenario 044 — in-session mutate_plan via dispatcher.
 *
 * Plan 029 (Plan D). Regression lock for the in-session branch of the
 * mutate_plan action. The user starts a fresh planning flow, reaches the
 * proposal phase, types "Move the flex to Sunday", and the dispatcher
 * picks `mutate_plan` (NOT `flow_input` — Plan D promotes mutate_plan
 * to AVAILABLE in the catalog, superseding Plan C's flow_input routing
 * for mutation-shaped text). The applier's in-session branch delegates
 * to the existing `handleMutationText` path, the re-proposer regenerates
 * the plan with the flex on Sunday, and the user approves.
 *
 * Functionally similar to scenario 037 (dispatcher-flow-input-planning)
 * but asserts the dispatcher chose `mutate_plan` rather than `flow_input`.
 * Scenario 037 is the Plan C regression lock; this scenario is the Plan D
 * regression lock that proves the catalog promotion works.
 *
 * Sequence:
 *   1. /start
 *   2. Tap 📋 Plan Week
 *   3. Tap plan_keep_breakfast
 *   4. Tap plan_no_events  (plan-proposer runs, proposal rendered)
 *   5. Type "Move the flex to Sunday" — dispatcher picks mutate_plan,
 *      applier in-session branch calls handleMutationText, re-proposer
 *      regenerates, diff rendered.
 *   6. Tap plan_approve — plan confirmed.
 *
 * Clock: 2026-04-05T10:00:00Z (Saturday before the plan week).
 * No seeded plan — fresh planning flow.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '044-mutate-plan-in-session',
  description:
    'In-session mutate_plan: dispatcher picks mutate_plan for mutation text during planning proposal phase, ' +
    'applier delegates to handleMutationText, re-proposer regenerates. Plan 029 regression lock.',
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
    click('plan_approve'),
  ],
});
