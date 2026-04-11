/**
 * Scenario 031 — shopping list tap mid-planning: audit regression lock.
 *
 * Part of Plan 027 (Navigation state model / Plan B audit). Proposal 003
 * explicitly flags the `shopping_list` menu handler's conditional clear of
 * `planFlow` (at `src/telegram/core.ts:1001`) as "wrong in some cases".
 * Plan B's decision is to LEAVE IT ALONE — no behavior change — and lock
 * in the current behavior with this scenario so a later plan that flips it
 * produces a visible regen diff.
 *
 * Setup: an active plan for this week (Mon–Sun Apr 6–12) is seeded so the
 * user's "📋 Plan Week" tap kicks off a NEXT-week planning draft. The user
 * reaches `planFlow.phase === 'context'` (no LLM calls — just the breakfast
 * prompt), then taps 🛒 Shopping List. Assertions:
 *
 *   - `planFlow` is `null` after the shopping-list tap (current conditional
 *     clear behavior is preserved).
 *   - `surfaceContext` is `'shopping'`.
 *   - `lastRenderedView` is `{ surface: 'shopping', view: 'next_cook' }`.
 *   - The shopping list text reflects the ACTIVE plan (this week), not
 *     the abandoned NEXT-week draft.
 *
 * Clock: 2026-04-08T10:00:00Z (Wed in the active week — active_mid).
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-031-0000-0000-0000-000000000001',
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

const activeBatches: Batch[] = [
  // Single lunch batch cooking on Thu Apr 9, remaining for Thu–Sat
  // (eatingDays[0] === Thu Apr 9 → sl_next will target that day)
  {
    id: 'batch-031-lunch-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' as const },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' as const },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' as const },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '031-shopping-list-mid-planning-audit',
  description:
    'Audit regression lock: user starts drafting next-week plan, taps 🛒 Shopping List — planFlow is cleared (current behavior, Plan B leaves alone), shopping list of the ACTIVE plan renders.',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    // Kick off next-week planning. lifecycle=active_mid → `plan_week` case
    // computes nextMonday via computeNextHorizonStart and calls
    // doStartPlanFlow, leaving planFlow.phase === 'context'.
    text('📋 Plan Week'),
    // Tap shopping list while planFlow is alive in context phase.
    // Handler clears planFlow and delegates to sl_next.
    text('🛒 Shopping List'),
  ],
});
