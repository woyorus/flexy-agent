/**
 * Scenario 046 — post-confirmation flex move via mutate_plan.
 *
 * Plan 029 (Plan D). The user has an active confirmed plan with the flex
 * on Saturday dinner. On Wednesday noon, they type "Move the flex to
 * Sunday lunch." The dispatcher picks `mutate_plan`, the applier's
 * post-confirmation branch runs the re-proposer, which shifts the flex
 * to Sunday lunch and rearranges batches accordingly. The user taps
 * `mp_confirm` to persist the change.
 *
 * Seed: active plan Apr 6–12 with:
 *   - Chicken grain-bowl lunch batch Mon–Wed (Apr 6–8)
 *   - Tagine dinner batch Mon–Wed (Apr 6–8)
 *   - Mediterranean tuna lunch batch Thu–Sat (Apr 9–11)
 *   - Pork rice bowls dinner batch Thu–Sat (Apr 9–11)
 *   - Flex slot: Saturday dinner (Apr 11)
 *
 * Clock: 2026-04-09T12:00:00Z (Wednesday noon — mid-week, past the
 * first cook batch, so the re-proposer must preserve Mon–Wed batches
 * as past and only rearrange Thu–Sun).
 *
 * Sequence:
 *   1. Type "Move the flex to Sunday lunch"
 *      — dispatcher picks mutate_plan, post-confirmation branch runs,
 *        re-proposer moves flex to Sun lunch, diff rendered with
 *        [Confirm] [Adjust].
 *   2. Tap mp_confirm — new plan session persisted, old superseded.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-046-0000-0000-0000-000000000001',
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
  mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
  confirmedAt: '2026-04-05T18:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-05T18:00:00.000Z',
  updatedAt: '2026-04-05T18:00:00.000Z',
};

const activeBatches: Batch[] = [
  // Batch 1: Mon–Wed Lunch (chicken grain bowl)
  {
    id: 'batch-046-lunch1-0000-0000-000000000001',
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
    id: 'batch-046-dinner1-0000-0000-000000000002',
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
  // Batch 3: Thu–Sat Lunch (Mediterranean tuna — lunch-compatible recipe)
  {
    id: 'batch-046-lunch2-0000-0000-000000000003',
    recipeSlug: 'mediterranean-tuna-chickpea-feta-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 780, protein: 52 },
    actualPerServing: { calories: 780, protein: 52, fat: 28, carbs: 82 },
    scaledIngredients: [
      { name: 'canned tuna, drained', amount: 150, unit: 'g', totalForBatch: 450, role: 'protein' as const },
      { name: 'chickpeas, canned, drained', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'feta cheese', amount: 30, unit: 'g', totalForBatch: 90, role: 'fat' as const },
      { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' as const },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 4: Thu–Fri Dinner (pork rice bowls — Sat is flex)
  {
    id: 'batch-046-dinner2-0000-0000-000000000004',
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
  name: '046-mutate-plan-flex-move',
  description:
    'Post-confirmation flex move: user types "Move the flex to Sunday lunch", dispatcher picks mutate_plan, ' +
    'post-confirmation re-proposer shifts flex, user taps mp_confirm. Plan 029.',
  clock: '2026-04-09T12:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('Move the flex to Sunday lunch'),
    click('mp_confirm'),
  ],
});
