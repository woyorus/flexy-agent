/**
 * Scenario 018 — plan view navigation.
 *
 * Exercises plan view screens (Next Action, Week Overview, Day Detail) and cook
 * view, connected through the natural navigation flow. No LLM calls — purely
 * seeded state exercising callback handlers.
 *
 * Clock: Wed Apr 8 (active_mid). Next cook day = Thu Apr 9.
 * - Mon-Wed meals are cooked (batch 1 lunch, batch 2 dinner)
 * - Thu-Sat meals upcoming (batch 3 lunch, batch 4 dinner)
 * - Sun: flex lunch + event dinner
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'session-016-0000-0000-0000-000000000001',
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
    { day: '2026-04-12', mealTime: 'lunch' as const, flexBonus: 300, note: 'flex lunch' },
  ],
  events: [
    { name: 'Sunday dinner out', day: '2026-04-12', mealTime: 'dinner' as const, estimatedCalories: 900 },
  ],
  mutationHistory: [],
  confirmedAt: '2026-04-06T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T08:00:00.000Z',
  updatedAt: '2026-04-06T08:00:00.000Z',
};

const activeBatches: Batch[] = [
  // Batch 1: Mon-Tue-Wed Lunch. Cook day = Apr 6 (past — reheat on clock date Apr 8).
  {
    id: 'batch-016-lunch1-0000-0000-000000000001',
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
      { name: 'smoked paprika', amount: 1, unit: 'tsp', totalForBatch: 3, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 2: Mon-Tue-Wed Dinner. Cook day = Apr 6 (past — reheat on clock date).
  {
    id: 'batch-016-dinner1-0000-0000-000000000002',
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
      { name: 'salt', amount: 0, unit: '', totalForBatch: 0, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 3: Thu-Fri-Sat Lunch. Cook day = Apr 9 (UPCOMING — next cook day from Apr 8).
  {
    id: 'batch-016-lunch2-0000-0000-000000000003',
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
      { name: 'black pepper', amount: 0, unit: '', totalForBatch: 0, role: 'seasoning' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 4: Thu-Fri-Sat Dinner. Cook day = Apr 9 (UPCOMING).
  {
    id: 'batch-016-dinner2-0000-0000-000000000004',
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
      { name: 'sesame oil', amount: 10, unit: 'ml', totalForBatch: 30, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '018-plan-view-navigation',
  description: 'Active-plan navigation: My Plan → Next Action → Week Overview → Day Detail → Cook view → back to plan',
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('📋 My Plan'),                     // handleMenu 'plan_week' → active_mid → na_show handler
    click('wo_show'),                        // Week Overview
    click('dd_2026-04-09'),                  // Day Detail — Thu Apr 9 (upcoming cook day)
    click('cv_batch-016-lunch2-0000-0000-000000000003'),  // Cook view: Ground Beef Rigatoni lunch
    click('na_show'),                        // Back to Next Action
  ],
});
