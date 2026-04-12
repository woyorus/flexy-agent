/**
 * Scenario 050 — mutate_plan with no active plan (no target).
 *
 * Plan 029 (Plan D). The user has no plan at all (`lifecycle: 'no_plan'`)
 * and types "move tomorrow dinner to Friday." The dispatcher picks
 * `mutate_plan` (the text is imperative-mutation-shaped), but the
 * applier's `no_target` branch fires because there is no active
 * planning session and no confirmed plan session. The user sees a
 * friendly "You don't have a plan yet — tap 📋 Plan Week to start."
 * message.
 *
 * Clock: 2026-04-05T10:00:00Z (Saturday, no plan seeded).
 *
 * Sequence:
 *   1. /start — main menu rendered, lifecycle: no_plan.
 *   2. Type "move tomorrow dinner to Friday"
 *      — dispatcher picks mutate_plan, applier finds no active flow
 *        and no persisted plan, returns no_target, user sees guidance.
 */

import { defineScenario, command, text } from '../../../src/harness/define.js';

export default defineScenario({
  name: '050-mutate-plan-no-target',
  description:
    'No target: user has no plan and types a mutation request. Dispatcher picks mutate_plan, ' +
    'applier returns no_target with guidance to start planning. Plan 029.',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
  },
  events: [
    command('start'),
    text('move tomorrow dinner to Friday'),
  ],
});
