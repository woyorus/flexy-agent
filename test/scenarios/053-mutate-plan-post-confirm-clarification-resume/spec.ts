/**
 * Scenario 053 — post-confirmation clarification multi-turn resume
 * (invariant #5 lock).
 *
 * Plan 029 (Plan D). The user has an active confirmed plan and types
 * "I'm eating out" — ambiguous because it doesn't specify lunch or
 * dinner. The dispatcher picks `mutate_plan`, the applier's
 * post-confirmation branch runs the re-proposer, which detects the
 * ambiguity and asks "lunch or dinner?" (clarification turn). The
 * user replies "dinner", which the dispatcher routes back into the
 * mutate_plan flow (the applier auto-resumes with the clarified
 * context). The re-proposer now has enough information, generates
 * the diff, and renders [Confirm] [Adjust]. The user taps mp_confirm.
 *
 * This locks invariant #5: multi-turn clarification within the
 * mutate_plan flow works end-to-end, and the second text message
 * doesn't restart the flow from scratch.
 *
 * Seed: active plan Apr 6–12 with (same as scenario 045):
 *   - Tagine dinner batch Mon–Wed (Apr 6–8)
 *   - Chicken grain-bowl lunch batch Mon–Wed (Apr 6–8)
 *   - Mediterranean tuna lunch batch Thu–Sat (Apr 9–11)
 *   - Pork rice bowls dinner batch Thu–Sat (Apr 9–11, 3 servings)
 *   - Chicken grain-bowl lunch batch Sun (Apr 12, 1 serving)
 *   - Flex slot: Sunday dinner (Apr 12)
 *
 * Clock: 2026-04-07T17:00:00Z (Tue 19:00 Europe/Madrid DST — before the
 * 21:00 local dinner cutoff so Tue dinner is still active. The user says
 * "eating out" without specifying lunch vs dinner, forcing a clarification
 * round.)
 *
 * Sequence:
 *   1. Type "I'm eating out"
 *      — dispatcher picks mutate_plan, re-proposer detects ambiguity
 *        (no meal time specified), asks "lunch or dinner?"
 *   2. Type "tonight for dinner"
 *      — dispatcher routes back into mutate_plan, applier auto-resumes
 *        with clarified context, re-proposer generates diff for
 *        Tuesday dinner eat-out, renders [Confirm] [Adjust].
 *   3. Tap mp_confirm — new plan session persisted, old superseded.
 */

import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const activeSession: PlanSession = {
  id: 'sess-053-0000-0000-0000-000000000001',
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
    id: 'batch-053-lunch1-0000-0000-000000000001',
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
    id: 'batch-053-dinner1-0000-0000-000000000002',
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
    id: 'batch-053-lunch2-0000-0000-000000000003',
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
  // Batch 4: Thu–Sat Dinner (pork rice bowls — covers Sat so flex can sit on Sun)
  {
    id: 'batch-053-dinner2-0000-0000-000000000004',
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
  // Batch 5: Sun Lunch (chicken, 1 serving — cooked fresh Sun)
  {
    id: 'batch-053-lunch3-0000-0000-000000000005',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-12'],
    servings: 1,
    targetPerServing: { calories: 893, protein: 56 },
    actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
    scaledIngredients: [
      { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 190, role: 'protein' as const },
      { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 75, role: 'carb' as const },
      { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 1, role: 'fat' as const },
      { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 22, role: 'fat' as const },
    ],
    status: 'planned',
    createdInPlanSessionId: activeSession.id,
  },
];

export default defineScenario({
  name: '053-mutate-plan-post-confirm-clarification-resume',
  description:
    'Post-confirmation clarification multi-turn: user says "I\'m eating out" (ambiguous), re-proposer asks ' +
    '"lunch or dinner?", user replies "dinner", applier auto-resumes, user taps mp_confirm. Invariant #5 lock. Plan 029.',
  clock: '2026-04-07T17:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [activeSession],
    batches: activeBatches,
  },
  events: [
    text("I'm eating out"),
    text('tonight for dinner'),
    click('mp_confirm'),
  ],
});
