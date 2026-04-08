/**
 * Scenario 022 — upcoming plan visibility.
 *
 * Exercises plan view screens when the plan hasn't started yet (lifecycle = 'upcoming').
 * The clock is set to one day before the plan's horizon start.
 *
 * Clock: Mon Apr 7 10:00 UTC. Plan: Apr 8–14 (starts tomorrow).
 *
 * Script:
 * 1. "📋 My Plan" → Next Action with contextual "No meals — your plan starts ..." for today
 * 2. wo_show → Week Overview (full 7-day plan)
 * 3. sl_next → Shopping list for first cook day (Apr 8)
 * 4. na_show → Back to Next Action
 * 5. "📋 Plan Week" → Replan prompt (future plan exists)
 * 6. plan_replan_cancel → "Plan kept." with correct menu keyboard
 *
 * Two cook days: Apr 8 (lunch + dinner) and Apr 11 (lunch + dinner).
 * Flex slot on Apr 14 lunch, event on Apr 14 dinner.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const futureSession: PlanSession = {
  id: 'session-022-0000-0000-0000-000000000001',
  horizonStart: '2026-04-08',
  horizonEnd: '2026-04-14',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 390,
    proteinPerDay: 31,
  },
  treatBudgetCalories: 1050,
  flexSlots: [
    { day: '2026-04-14', mealTime: 'lunch' as const, flexBonus: 300, note: 'flex lunch' },
  ],
  events: [
    { name: 'Sunday dinner out', day: '2026-04-14', mealTime: 'dinner' as const, estimatedCalories: 900 },
  ],
  confirmedAt: '2026-04-07T08:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-07T08:00:00.000Z',
  updatedAt: '2026-04-07T08:00:00.000Z',
};

const futureBatches: Batch[] = [
  // Batch 1: Wed-Thu-Fri Lunch. Cook day = Apr 8.
  {
    id: 'batch-022-lunch1-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-08', '2026-04-09', '2026-04-10'],
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
    createdInPlanSessionId: futureSession.id,
  },
  // Batch 2: Wed-Thu-Fri Dinner. Cook day = Apr 8.
  {
    id: 'batch-022-dinner1-0000-0000-000000000002',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-08', '2026-04-09', '2026-04-10'],
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
    createdInPlanSessionId: futureSession.id,
  },
  // Batch 3: Sat-Sun-Mon Lunch. Cook day = Apr 11.
  {
    id: 'batch-022-lunch2-0000-0000-000000000003',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'lunch',
    eatingDays: ['2026-04-11', '2026-04-12', '2026-04-13'],
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
    createdInPlanSessionId: futureSession.id,
  },
  // Batch 4: Sat-Sun-Mon Dinner. Cook day = Apr 11.
  {
    id: 'batch-022-dinner2-0000-0000-000000000004',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'dinner',
    eatingDays: ['2026-04-11', '2026-04-12', '2026-04-13'],
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
    createdInPlanSessionId: futureSession.id,
  },
];

export default defineScenario({
  name: '022-upcoming-plan-view',
  description: 'Upcoming plan visibility: My Plan, Week Overview, Shopping List, Plan Week replan prompt — all before plan starts',
  clock: '2026-04-07T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [futureSession],
    batches: futureBatches,
  },
  events: [
    text('\ud83d\udccb My Plan'),                     // 1. Next Action with upcoming plan
    click('wo_show'),                        // 2. Week Overview
    click('sl_next'),                        // 3. Shopping list for first cook day
    click('na_show'),                        // 4. Back to Next Action
    text('\ud83d\udccb Plan Week'),                    // 5. Replan prompt — future plan exists
    click('plan_replan_cancel'),             // 6. "Plan kept." with menu keyboard
  ],
});
