/**
 * Scenario 062 — show_shopping_list with full_week scope.
 *
 * Plan 030 (Plan E). User types "full shopping list for the week". The
 * dispatcher picks `show_shopping_list({ scope: 'full_week' })`, the
 * handler calls `generateShoppingListForWeek` and renders the week-spanning
 * list aggregating all batches in the plan plus prorated breakfast.
 *
 * Seed: active plan Apr 6–12 with the standard four-batch layout plus
 * breakfast. All four batches and breakfast contribute to the full-week list.
 *
 * Sequence:
 *   1. Type "full shopping list for the week" — dispatcher picks
 *      show_shopping_list full_week scope, handler renders.
 *
 * Clock: 2026-04-07T10:00:00Z (Tuesday morning).
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-062-0000-0000-0000-000000000001',
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
    { day: '2026-04-11', mealTime: 'dinner' as const, flexBonus: 300, note: 'flex dinner' },
  ],
  events: [],
  mutationHistory: [],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

const activeBatches: Batch[] = [
  // Batch 1: Mon–Wed Lunch (chicken grain bowl)
  {
    id: 'batch-062-lunch1-0000-0000-000000000001',
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
  // Batch 2: Mon–Wed Dinner (tagine)
  {
    id: 'batch-062-dinner1-0000-0000-000000000002',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
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
    id: 'batch-062-lunch2-0000-0000-000000000003',
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
  // Batch 4: Thu–Fri Dinner (pork rice bowls)
  {
    id: 'batch-062-dinner2-0000-0000-000000000004',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10'],
    servings: 2,
    targetPerServing: { calories: 650, protein: 44 },
    actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
    scaledIngredients: [
      { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 360, role: 'protein' as const },
      { name: 'broccoli', amount: 100, unit: 'g', totalForBatch: 200, role: 'vegetable' as const },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 160, role: 'carb' as const },
      { name: 'soy sauce', amount: 20, unit: 'ml', totalForBatch: 40, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '062-show-shopping-list-full-week',
  description:
    'User types "full shopping list for the week". Dispatcher picks show_shopping_list full_week scope, ' +
    'handler aggregates all batches + breakfast into a single list. Plan 030.',
  clock: '2026-04-07T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('full shopping list for the week'),
  ],
});
