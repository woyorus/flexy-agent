/**
 * Scenario 054 — answer_plan_question via dispatcher.
 *
 * Plan 030 (Plan E). User with an active confirmed plan types "When's my
 * next cook day?". The dispatcher picks `answer_plan_question`, replies
 * inline with the answer derived from the plan summary in context, and
 * session state remains unchanged (no flow transition, no surface change).
 *
 * Seed: active plan Apr 6–12 with the standard four-batch layout
 * (Mon–Wed lunch/dinner, Thu–Sat lunch/dinner). Clock is Tuesday morning,
 * so the next cook day is Thursday Apr 9 (eatingDays[0] of batch 3/4).
 *
 * Sequence:
 *   1. Tap "My Plan" (reply keyboard) — establishes plan surface context.
 *   2. Type "When's my next cook day?" — dispatcher picks answer_plan_question,
 *      responds inline with the answer.
 *
 * Clock: 2026-04-07T10:00:00Z (Tuesday morning).
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-054-0000-0000-0000-000000000001',
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
    id: 'batch-054-lunch1-0000-0000-000000000001',
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
    id: 'batch-054-dinner1-0000-0000-000000000002',
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
    id: 'batch-054-lunch2-0000-0000-000000000003',
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
  // Batch 4: Thu–Fri Dinner (pork rice bowls — Sat is flex)
  {
    id: 'batch-054-dinner2-0000-0000-000000000004',
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
  name: '054-answer-plan-question',
  description:
    'User with active plan asks "When\'s my next cook day?". Dispatcher picks answer_plan_question, ' +
    'replies inline with the answer. Plan 030.',
  clock: '2026-04-07T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('\ud83d\udccb My Plan'),
    text("When's my next cook day?"),
  ],
});
