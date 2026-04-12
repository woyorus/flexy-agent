/**
 * Scenario 047 — post-confirmation recipe swap via mutate_plan.
 *
 * Plan 029 (Plan D). The user has an active confirmed plan with the
 * tagine dinner batch spanning Thu–Sat. On Monday noon, they type
 * "swap the tagine for something lighter." The dispatcher picks
 * `mutate_plan`, the applier's post-confirmation branch runs the
 * re-proposer, which picks a different recipe from the library that
 * passes the meal-type lane rule (must be a dinner recipe), renders
 * the diff + `[Confirm] [Adjust]`. The user taps `mp_confirm`.
 *
 * Seed: active plan Apr 6–12 with:
 *   - Chicken grain-bowl lunch batch Mon–Wed (Apr 6–8)
 *   - Salmon linguine dinner batch Mon–Wed (Apr 6–8)
 *   - Tuna chickpea lunch batch Thu–Sat (Apr 9–11)
 *   - Tagine dinner batch Thu–Sat (Apr 9–11)
 *   - Flex slot: Sunday dinner (Apr 12)
 *
 * Clock: 2026-04-07T12:00:00Z (Monday noon — early in the week, so
 * the re-proposer has maximum flexibility to rearrange the upcoming
 * Thu–Sat dinner batch).
 *
 * Sequence:
 *   1. Type "swap the tagine for something lighter"
 *      — dispatcher picks mutate_plan, post-confirmation branch runs,
 *        re-proposer replaces tagine with another dinner recipe, diff
 *        rendered with [Confirm] [Adjust].
 *   2. Tap mp_confirm — new plan session persisted, old superseded.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-047-0000-0000-0000-000000000001',
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
    id: 'batch-047-lunch1-0000-0000-000000000001',
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
  // Batch 2: Mon–Wed Dinner (salmon linguine)
  {
    id: 'batch-047-dinner1-0000-0000-000000000002',
    recipeSlug: 'creamy-salmon-and-shrimp-linguine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 30, carbs: 68 },
    scaledIngredients: [
      { name: 'salmon fillet', amount: 150, unit: 'g', totalForBatch: 450, role: 'protein' as const },
      { name: 'shrimp, peeled', amount: 60, unit: 'g', totalForBatch: 180, role: 'protein' as const },
      { name: 'linguine', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' as const },
      { name: 'heavy cream', amount: 30, unit: 'ml', totalForBatch: 90, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
  // Batch 3: Thu–Sat Lunch (tuna chickpea)
  {
    id: 'batch-047-lunch2-0000-0000-000000000003',
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
  // Batch 4: Thu–Sat Dinner (tagine — the one the user wants to swap)
  {
    id: 'batch-047-dinner2-0000-0000-000000000004',
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
];

export default defineScenario({
  name: '047-mutate-plan-recipe-swap',
  description:
    'Post-confirmation recipe swap: user types "swap the tagine for something lighter", dispatcher picks mutate_plan, ' +
    're-proposer picks a different dinner recipe, user taps mp_confirm. Plan 029.',
  clock: '2026-04-07T12:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('swap the tagine for something lighter'),
    click('mp_confirm'),
  ],
});
