/**
 * Scenario 049 — mp_adjust loop: reject first proposal, adjust, confirm.
 *
 * Plan 029 (Plan D). Exercises the `mp_adjust` inline callback: the user
 * has an active confirmed plan, types a mutation request, sees the diff
 * with `[Confirm] [Adjust]`, taps `[Adjust]` (`mp_adjust` callback), the
 * `pendingMutation` is cleared and the bot replies with a "tell me what
 * to change" prompt. The user types a new request, the full
 * mutate_plan cycle runs again (dispatcher → applier → re-proposer →
 * diff), and the user taps `[Confirm]` (`mp_confirm`) to persist.
 *
 * Seed: active plan Apr 6–12 with:
 *   - Chicken grain-bowl lunch batch Mon–Wed (Apr 6–8)
 *   - Tagine dinner batch Mon–Wed (Apr 6–8)
 *   - Bolognese lunch batch Thu–Sat (Apr 9–11)
 *   - Pork rice bowls dinner batch Thu–Fri (Apr 9–10), flex Sat dinner
 *
 * Clock: 2026-04-09T12:00:00Z (Wednesday noon).
 *
 * Sequence:
 *   1. Type "Move the flex to Sunday lunch"
 *      — dispatcher picks mutate_plan, post-confirmation branch runs,
 *        diff rendered with [Confirm] [Adjust].
 *   2. Tap mp_adjust — pendingMutation cleared, bot prompts for changes.
 *   3. Type "Actually, move the flex to Friday dinner instead"
 *      — dispatcher picks mutate_plan again, full cycle re-runs,
 *        new diff rendered with [Confirm] [Adjust].
 *   4. Tap mp_confirm — new plan session persisted, old superseded.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-049-0000-0000-0000-000000000001',
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
    id: 'batch-049-lunch1-0000-0000-000000000001',
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
    id: 'batch-049-dinner1-0000-0000-000000000002',
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
    id: 'batch-049-lunch2-0000-0000-000000000003',
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
    id: 'batch-049-dinner2-0000-0000-000000000004',
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
  name: '049-mutate-plan-adjust-loop',
  description:
    'mp_adjust loop: user requests mutation, taps [Adjust], types new request, taps [Confirm]. ' +
    'Proves the adjust-and-retry cycle works end-to-end. Plan 029.',
  clock: '2026-04-09T12:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('Move the flex to Sunday lunch'),
    click('mp_adjust'),
    text('Actually, move the flex to Friday dinner instead'),
    click('mp_confirm'),
  ],
});
