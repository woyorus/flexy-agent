/**
 * Scenario 059 — show_recipe when the recipe appears in two active batches.
 *
 * Plan 030 (Plan E). User types "show me the chicken grain bowl" and that
 * recipe (chicken-black-bean-avocado-rice-bowl) appears in TWO active
 * batches with different cook days: Mon–Wed lunch (batch 1) and Fri–Sun
 * lunch (batch 5). The handler picks the batch with the soonest
 * eatingDays[0] (Mon = 2026-04-06) and renders its cook view.
 *
 * This scenario is the regression lock for the v0.0.5 multi-batch
 * disambiguation rule: "pick the batch with the soonest cook day."
 *
 * Seed: active plan Apr 6–12 with a MODIFIED layout that includes the
 * chicken grain bowl in two lunch batches (Mon–Wed and Fri–Sun) to create
 * the multi-batch condition.
 *
 * Sequence:
 *   1. Type "show me the chicken grain bowl" — dispatcher picks show_recipe,
 *      handler finds two batches, picks the soonest (Mon), renders cook view.
 *
 * Clock: 2026-04-06T08:00:00Z (Monday morning — before either batch cooks).
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-059-0000-0000-0000-000000000001',
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
  mutationHistory: [],
  confirmedAt: '2026-04-05T18:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-05T18:00:00.000Z',
  updatedAt: '2026-04-05T18:00:00.000Z',
};

const activeBatches: Batch[] = [
  // Batch 1: Mon–Wed Lunch (chicken grain bowl — FIRST occurrence, soonest cook day)
  {
    id: 'batch-059-lunch1-0000-0000-000000000001',
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
    id: 'batch-059-dinner1-0000-0000-000000000002',
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
  // Batch 3: Thu–Sat Dinner (pork rice bowls)
  {
    id: 'batch-059-dinner2-0000-0000-000000000003',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 650, protein: 44 },
    actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
    scaledIngredients: [
      { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' as const },
      { name: 'broccoli', amount: 100, unit: 'g', totalForBatch: 300, role: 'vegetable' as const },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'soy sauce', amount: 20, unit: 'ml', totalForBatch: 60, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 4: Fri–Sun Lunch (chicken grain bowl — SECOND occurrence, later cook day)
  {
    id: 'batch-059-lunch2-0000-0000-000000000004',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-10', '2026-04-11', '2026-04-12'],
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
  name: '059-show-recipe-multi-batch',
  description:
    'User types "show me the chicken grain bowl" — recipe is in two active batches (Mon and Fri). ' +
    'Handler picks the batch with the soonest cook day (Mon) and renders its cook view. ' +
    'Multi-batch disambiguation regression lock. Plan 030.',
  clock: '2026-04-06T08:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('show me the chicken grain bowl'),
  ],
});
