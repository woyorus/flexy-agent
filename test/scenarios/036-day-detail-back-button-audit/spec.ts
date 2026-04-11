/**
 * Scenario 036 — day detail "← Back to week" button regression lock.
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Directly answers
 * proposal 003's explicitly-named audit outcome at
 * `docs/design-docs/proposals/003-freeform-conversation-layer.md:755`:
 * "user drills into day detail then back — returns to day detail or to
 * week overview?"
 *
 * The current user-visible answer is **week overview**, enforced by the
 * hardcoded callback at `src/telegram/keyboards.ts:354`
 * (`kb.text('← Back to week', 'wo_show')`). Plan 027 does NOT change this
 * (scope guard: no keyboard modifications), but this scenario LOCKS IN
 * the current behavior so Plan C's eventual dispatcher-driven back
 * computation produces a focused, visible diff rather than a silent
 * behavioral drift.
 *
 * Journey (all clicks; no LLM calls):
 *   [0]  📋 My Plan          → { surface: 'plan', view: 'next_action' }
 *   [1]  wo_show              → { surface: 'plan', view: 'week_overview' }
 *   [2]  dd_2026-04-09        → { surface: 'plan', view: 'day_detail', day: '2026-04-09' }
 *   [3]  wo_show (back tap)   → { surface: 'plan', view: 'week_overview' }
 *
 * The load-bearing assertion is `sessionAt[3].lastRenderedView.view ===
 * 'week_overview'`: after tapping "← Back to week" from day detail, the
 * user MUST land on week overview. Any Plan C change that re-routes this
 * button will fail this scenario on the next `npm test` until the
 * regeneration review confirms the new behavior is intentional.
 *
 * Clock: 2026-04-08T10:00:00Z (active_mid, same seed shape as scenarios
 * 018 and 030 so the batch IDs and day references match).
 * Seed: active plan + batches sufficient for `dd_2026-04-09` to render
 *       (Thu Apr 9 is the next cook day).
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-036-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [],
  events: [],
  mutationHistory: [],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

/** Minimum batches so dd_2026-04-09 renders a non-empty day detail view. */
const activeBatches: Batch[] = [
  {
    id: 'batch-036-lunch-0000-0000-000000000001',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
    scaledIngredients: [
      { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '036-day-detail-back-button-audit',
  description:
    'Audit regression lock (proposal 003 §755 named outcome): user drills my_plan → wo_show → dd_<date>, taps "← Back to week" (which sends wo_show), and lands on week_overview. Per-step sessionAt[] assertions lock in the v0.0.5 back-button outcome before Plan C changes it.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  captureStepState: true,
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('📋 My Plan'),         // sessionAt[0] — plan/next_action
    click('wo_show'),            // sessionAt[1] — plan/week_overview
    click('dd_2026-04-09'),      // sessionAt[2] — plan/day_detail
    click('wo_show'),            // sessionAt[3] — plan/week_overview (back-button outcome)
  ],
});
