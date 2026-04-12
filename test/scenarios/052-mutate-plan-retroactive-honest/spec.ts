/**
 * Scenario 052 — retroactive mutation: "last night I went to Indian."
 *
 * Plan 029 (Plan D). The user wakes up on Wednesday morning and tells
 * the bot they ate out the previous night (Tuesday dinner). The
 * dispatcher picks `mutate_plan`, the applier's post-confirmation
 * branch runs the re-proposer in `post-confirmation` mode. The
 * re-proposer should mark Tuesday dinner as an eat-out event
 * retroactively and cascade any batch changes (the tagine Mon–Wed
 * batch loses a serving, potentially shrinking to 2). The user taps
 * `mp_confirm` to persist the change.
 *
 * This is a retroactive honesty scenario — the user didn't tell the
 * bot in advance; they're reporting after the fact. The plan
 * adjustment applies to a past day.
 *
 * Seed: active plan Apr 6–12 with:
 *   - Tagine dinner batch Mon–Wed (Apr 6–8), 3 servings
 *   - Pork rice bowls dinner batch Thu–Sat (Apr 9–11), 3 servings
 *   - Chicken grain-bowl lunch batch Mon–Fri (Apr 6–10), 5 servings
 *   - Flex slot: Sunday dinner (Apr 12)
 *
 * Clock: 2026-04-08T09:00:00Z (Wednesday morning — "last night" =
 * Tue Apr 7 dinner, which falls within the tagine batch window).
 *
 * Sequence:
 *   1. Type "last night I went to an Indian restaurant"
 *      — dispatcher picks mutate_plan, post-confirmation branch runs,
 *        re-proposer retroactively removes Tue dinner from tagine batch
 *        or adds an eat-out event for Tue dinner, diff rendered with
 *        [Confirm] [Adjust].
 *   2. Tap mp_confirm — new plan session persisted, old superseded.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-052-0000-0000-0000-000000000001',
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
  // Batch 1: Mon–Wed Dinner (tagine — Tue dinner will be retroactively replaced)
  {
    id: 'batch-052-dinner1-0000-0000-000000000001',
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
  // Batch 2: Thu–Sat Dinner (pork rice bowls)
  {
    id: 'batch-052-dinner2-0000-0000-000000000002',
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
  // Batch 3: Mon–Fri Lunch (chicken grain bowl — 5 servings)
  {
    id: 'batch-052-lunch1-0000-0000-000000000003',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10'],
    servings: 5,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 950, role: 'protein' as const },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 375, role: 'carb' as const },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 5, role: 'fat' as const },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 110, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '052-mutate-plan-retroactive-honest',
  description:
    'Retroactive mutation: user reports "last night I went to Indian" on Wednesday morning. ' +
    'Re-proposer adjusts Tuesday dinner retroactively, user taps mp_confirm. Plan 029.',
  clock: '2026-04-08T09:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text('last night I went to an Indian restaurant'),
    click('mp_confirm'),
  ],
});
