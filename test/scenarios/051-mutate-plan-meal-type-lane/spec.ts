/**
 * Scenario 051 — meal-type lane regression lock.
 *
 * Plan 029 (Plan D). The user has an active confirmed plan with a tagine
 * dinner batch spanning Thu–Sat. On Wednesday noon, they type "Move
 * tomorrow's tagine to lunch." The tagine is a dinner-only recipe — it
 * cannot be moved to a lunch lane. The re-proposer should refuse the
 * cross-lane move and either clarify, explain the constraint, or offer
 * a swap to a lunch-eligible recipe.
 *
 * This scenario captures only the first response — no `mp_confirm` —
 * because the user doesn't confirm anything. We only care about how
 * the system handles the invalid lane crossing.
 *
 * Seed: active plan Apr 6–12 with:
 *   - Chicken grain-bowl lunch batch Mon–Wed (Apr 6–8)
 *   - Tagine dinner batch Thu–Sat (Apr 9–11)
 *   - Bolognese lunch batch Thu–Sat (Apr 9–11)
 *   - Flex slot: Sunday dinner (Apr 12)
 *
 * Clock: 2026-04-09T12:00:00Z (Wednesday noon — "tomorrow" = Thu Apr 10,
 * which falls within the tagine batch window).
 *
 * Sequence:
 *   1. Type "Move tomorrow's tagine to lunch"
 *      — dispatcher picks mutate_plan, post-confirmation branch runs,
 *        re-proposer detects dinner-only constraint and responds
 *        accordingly (refusal, clarification, or swap suggestion).
 *      No mp_confirm — single-turn only.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-051-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [
    { day: '2026-04-12', mealTime: 'dinner' as const, flexBonus: 300, note: 'flex dinner' },
  ],
  events: [],
  mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
  confirmedAt: '2026-04-05T18:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-05T18:00:00.000Z',
  updatedAt: '2026-04-05T18:00:00.000Z',
};

const activeBatches: Batch[] = [
  // Batch 1: Mon–Wed Lunch (chicken grain bowl)
  {
    id: 'batch-051-lunch1-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
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
  // Batch 2: Thu–Sat Dinner (tagine — the one the user wants to move to lunch)
  {
    id: 'batch-051-dinner1-0000-0000-000000000002',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
    scaledIngredients: [
      { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' as const },
      { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 3: Thu–Sat Lunch (bolognese)
  {
    id: 'batch-051-lunch2-0000-0000-000000000003',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
    scaledIngredients: [
      { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' as const },
      { name: 'cherry tomatoes', amount: 150, unit: 'g', totalForBatch: 450, role: 'vegetable' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '051-mutate-plan-meal-type-lane',
  description:
    'Meal-type lane regression: user tries to move a dinner-only tagine to lunch lane. ' +
    'Re-proposer should refuse, clarify, or suggest a swap — not silently cross lanes. Plan 029.',
  clock: '2026-04-09T12:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text("Move tomorrow's tagine to lunch"),
  ],
});
