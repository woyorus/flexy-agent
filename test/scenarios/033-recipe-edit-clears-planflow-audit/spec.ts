/**
 * Scenario 033 — `re_<slug>` callback clears `planFlow` (audit lock).
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Covers audit
 * site #5 from the plan's decision table. The user taps Plan Week (kicking
 * off a fresh planning draft with `planFlow.phase === 'context'`), then
 * navigates to the recipe library via 📖 My Recipes (which does NOT clear
 * planFlow — see handleMenu's inline comment at src/telegram/core.ts:905),
 * taps a recipe (rv_), then taps "Edit this recipe" (re_). The scenario
 * asserts:
 *
 *   - `planFlow === null` after the re_ tap (audit decision "leave alone" —
 *     current defensive clear behavior preserved).
 *   - `recipeFlow` is set to an edit flow state (the tap enters the edit UX).
 *
 * Setup: no active plan exists — this is a fresh user starting their first
 * plan. With no future, running, or historical session, `computeNextHorizonStart`
 * falls through to its "tomorrow" branch (`src/agents/plan-flow.ts:208`) and
 * returns `addDays(today, 1)` = `2026-04-09` (Thu). The horizon is Thu Apr 9
 * through Wed Apr 15 — a rolling-7-day window starting tomorrow, NOT a
 * Monday-aligned calendar week. `doStartPlanFlow` parks planFlow at
 * `phase === 'context'` and replies with the breakfast prompt, without any
 * LLM call.
 *
 * Clock: 2026-04-08T10:00:00Z. Zero LLM calls.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '033-recipe-edit-clears-planflow-audit',
  description:
    'Audit regression lock: user has planFlow alive at phase=context, taps re_<slug> from recipe view — planFlow cleared (Plan 027 decision "leave alone").',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: { session: null },
  events: [
    text('📋 Plan Week'),                             // planFlow.phase === 'context', breakfast prompt rendered
    text('📖 My Recipes'),                            // library renders, planFlow UNTOUCHED (handleMenu only clears recipeFlow/progressFlow)
    click('rv_chicken-black-bean-avocado-rice-bowl'), // recipe detail, planFlow still untouched
    click('re_chicken-black-bean-avocado-rice-bowl'), // CLEARS planFlow, enters edit flow
  ],
});
