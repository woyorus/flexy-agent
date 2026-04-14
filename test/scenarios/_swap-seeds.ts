/**
 * Shared seed helpers for the Plan 033 emergency-ingredient-swap scenario
 * suite (066–086).
 *
 * Lives at the scenarios root (not in a `NNN-*` directory) so the loader's
 * `discoverScenarios` — which walks immediate subdirectories for
 * `spec.ts` files — never picks it up as a scenario. Spec files import
 * from `../_swap-seeds.js` to assemble their initialState.
 */

import type { PlanSession, Batch } from '../../src/models/types.js';

/**
 * Build an active confirmed plan session for scenario NNN with horizon
 * Apr 6–12 2026 (a Mon–Sun stretch). Overridable horizon bounds let
 * past-batch / multi-horizon scenarios tweak the dates.
 */
export function buildSwapSession(nnn: string, overrides: Partial<Omit<PlanSession, 'id'>> = {}): PlanSession {
  return {
    id: `sess-${nnn}-0000-0000-0000-000000000001`,
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
    ...overrides,
  };
}

/**
 * Canonical four-batch active plan for a typical swap scenario:
 *   - Mon–Wed lunch: chicken black-bean rice bowl (3 servings)
 *   - Mon–Wed dinner: Moroccan beef tagine (3 servings)
 *   - Thu–Sat lunch: beef bolognese rigatoni (3 servings) — carries cherry tomatoes + olive oil
 *   - Thu–Fri dinner: soy-ginger pork rice bowls (2 servings, Sat is the flex day)
 *
 * Returns batches parented to `sessionId`. Each batch's `nnn` prefix keeps
 * IDs unique across scenarios so snapshots don't collide if two scenarios
 * are compared side-by-side.
 */
export function buildSwapBatches(nnn: string, sessionId: string): Batch[] {
  return [
    {
      id: `batch-${nnn}-lunch1-0000-0000-000000000001`,
      recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 893, protein: 56 },
      actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
      scaledIngredients: [
        { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' },
        { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' },
        { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' },
        { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' },
      ],
      status: 'planned',
      createdInPlanSessionId: sessionId,
    },
    {
      id: `batch-${nnn}-dinner1-0000-0000-000000000002`,
      recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
      mealType: 'dinner',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 720, protein: 48 },
      actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
      scaledIngredients: [
        { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
        { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' },
        { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' },
        { name: 'dry white wine', amount: 60, unit: 'ml', totalForBatch: 180, role: 'seasoning' },
        { name: 'passata', amount: 100, unit: 'g', totalForBatch: 300, role: 'vegetable' },
        { name: 'raisins', amount: 30, unit: 'g', totalForBatch: 90, role: 'carb' },
        { name: 'parsley', amount: 10, unit: 'g', totalForBatch: 30, role: 'seasoning' },
      ],
      status: 'planned',
      createdInPlanSessionId: sessionId,
    },
    {
      id: `batch-${nnn}-lunch2-0000-0000-000000000003`,
      recipeSlug: 'ground-beef-rigatoni-bolognese',
      mealType: 'lunch',
      eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
      servings: 3,
      targetPerServing: { calories: 780, protein: 52 },
      actualPerServing: { calories: 780, protein: 52, fat: 32, carbs: 78 },
      scaledIngredients: [
        { name: 'ground beef', amount: 180, unit: 'g', totalForBatch: 540, role: 'protein' },
        { name: 'rigatoni', amount: 90, unit: 'g', totalForBatch: 270, role: 'carb' },
        { name: 'cherry tomatoes', amount: 150, unit: 'g', totalForBatch: 450, role: 'vegetable' },
        { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' },
      ],
      status: 'planned',
      createdInPlanSessionId: sessionId,
    },
    {
      id: `batch-${nnn}-dinner2-0000-0000-000000000004`,
      recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
      mealType: 'dinner',
      eatingDays: ['2026-04-09', '2026-04-10'],
      servings: 2,
      targetPerServing: { calories: 650, protein: 44 },
      actualPerServing: { calories: 650, protein: 44, fat: 22, carbs: 65 },
      scaledIngredients: [
        { name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 360, role: 'protein' },
        { name: 'broccoli', amount: 100, unit: 'g', totalForBatch: 200, role: 'vegetable' },
        { name: 'basmati rice', amount: 80, unit: 'g', totalForBatch: 160, role: 'carb' },
        { name: 'soy sauce', amount: 20, unit: 'ml', totalForBatch: 40, role: 'seasoning' },
      ],
      status: 'planned',
      createdInPlanSessionId: sessionId,
    },
  ];
}

/**
 * Build a session whose "salmon" appears in a SINGLE batch. Used by
 * scenarios where the applier must bind "no salmon" to exactly one
 * batch (ambiguous-target clarification path).
 */
export function buildSalmonSession(nnn: string): { session: PlanSession; batches: Batch[] } {
  const session = buildSwapSession(nnn);
  const batches: Batch[] = [
    // Salmon-only batch — Thu/Fri dinner
    {
      id: `batch-${nnn}-salmon-0000-0000-000000000001`,
      recipeSlug: 'creamy-salmon-and-shrimp-linguine',
      mealType: 'dinner',
      eatingDays: ['2026-04-09', '2026-04-10'],
      servings: 2,
      targetPerServing: { calories: 780, protein: 48 },
      actualPerServing: { calories: 780, protein: 48, fat: 34, carbs: 70 },
      scaledIngredients: [
        { name: 'salmon fillet', amount: 150, unit: 'g', totalForBatch: 300, role: 'protein' },
        { name: 'shrimp', amount: 100, unit: 'g', totalForBatch: 200, role: 'protein' },
        { name: 'linguine', amount: 90, unit: 'g', totalForBatch: 180, role: 'carb' },
        { name: 'heavy cream', amount: 40, unit: 'ml', totalForBatch: 80, role: 'fat' },
      ],
      status: 'planned',
      createdInPlanSessionId: session.id,
    },
    // Beef tagine (no salmon) Mon–Wed dinner to prove the resolver picks only the salmon batch
    ...buildSwapBatches(nnn, session.id).slice(1, 3),
  ];
  return { session, batches };
}

/**
 * Build a plan where the SAME protein (chicken) sits in two active
 * batches — used by the multi-batch ambiguity scenario (071).
 */
export function buildMultiBatchChickenSession(nnn: string): { session: PlanSession; batches: Batch[] } {
  const session = buildSwapSession(nnn);
  const batches: Batch[] = [
    {
      id: `batch-${nnn}-chicken1-0000-0000-000000000001`,
      recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 893, protein: 56 },
      actualPerServing: { calories: 893, protein: 56, fat: 46, carbs: 68 },
      scaledIngredients: [
        { name: 'chicken breast, raw', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' },
        { name: 'black beans, canned, drained', amount: 75, unit: 'g', totalForBatch: 225, role: 'carb' },
        { name: 'small avocado', amount: 1, unit: 'whole', totalForBatch: 3, role: 'fat' },
        { name: 'olive oil', amount: 22, unit: 'ml', totalForBatch: 66, role: 'fat' },
      ],
      status: 'planned',
      createdInPlanSessionId: session.id,
    },
    // Second chicken batch (Thu–Sat dinner — retrofit a chicken bowl to second slot)
    {
      id: `batch-${nnn}-chicken2-0000-0000-000000000002`,
      recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
      mealType: 'dinner',
      eatingDays: ['2026-04-09', '2026-04-10'],
      servings: 2,
      targetPerServing: { calories: 650, protein: 44 },
      actualPerServing: { calories: 650, protein: 44, fat: 28, carbs: 56 },
      scaledIngredients: [
        { name: 'chicken breast, raw', amount: 160, unit: 'g', totalForBatch: 320, role: 'protein' },
        { name: 'black beans, canned, drained', amount: 60, unit: 'g', totalForBatch: 120, role: 'carb' },
        { name: 'olive oil', amount: 18, unit: 'ml', totalForBatch: 36, role: 'fat' },
      ],
      status: 'planned',
      createdInPlanSessionId: session.id,
    },
  ];
  return { session, batches };
}

/**
 * Build a batch whose every eating day is strictly BEFORE the clock date
 * — used by the past-batch hard_no scenario (076). Clock is expected to
 * be 2026-04-10 or later.
 */
export function buildPastBatchSession(nnn: string): { session: PlanSession; batches: Batch[] } {
  const session = buildSwapSession(nnn);
  const batches: Batch[] = [
    {
      id: `batch-${nnn}-past-0000-0000-000000000001`,
      recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
      mealType: 'dinner',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 720, protein: 48 },
      actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
      scaledIngredients: [
        { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
        { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' },
        { name: 'dry white wine', amount: 60, unit: 'ml', totalForBatch: 180, role: 'seasoning' },
      ],
      status: 'planned',
      createdInPlanSessionId: session.id,
    },
  ];
  return { session, batches };
}

/**
 * A batch already carrying a swap history — used by reversal scenarios
 * (073, 074, 075). `nameOverride` + `bodyOverride` + `swapHistory` mimic
 * what the applier would have persisted after prior swaps.
 */
export function buildBatchWithSwapHistory(nnn: string, sessionId: string): Batch {
  return {
    id: `batch-${nnn}-history-0000-0000-000000000001`,
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 720, protein: 48 },
    actualPerServing: { calories: 720, protein: 48, fat: 28, carbs: 72 },
    scaledIngredients: [
      { name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
      { name: 'couscous', amount: 80, unit: 'g', totalForBatch: 240, role: 'carb' },
      { name: 'olive oil', amount: 15, unit: 'ml', totalForBatch: 45, role: 'fat' },
      { name: 'beef stock', amount: 60, unit: 'ml', totalForBatch: 180, role: 'seasoning' },
      { name: 'lemon juice', amount: 10, unit: 'ml', totalForBatch: 30, role: 'seasoning' },
      { name: 'cherry tomatoes', amount: 150, unit: 'g', totalForBatch: 450, role: 'vegetable' },
    ],
    status: 'planned',
    createdInPlanSessionId: sessionId,
    nameOverride: 'Beef Tagine (stock swap + cherry tomatoes)',
    swapHistory: [
      {
        appliedAt: '2026-04-08T18:00:00.000Z',
        userMessage: 'no white wine, use beef stock instead',
        changes: [
          {
            kind: 'replace',
            from: 'dry white wine',
            to: 'beef stock',
            fromAmount: 60,
            fromUnit: 'ml',
            toAmount: 60,
            toUnit: 'ml',
          },
          { kind: 'add', ingredient: 'lemon juice', amount: 10, unit: 'ml', reason: 'helper' },
        ],
        resultingMacros: { calories: 720, protein: 48, fat: 28, carbs: 72 },
      },
      {
        appliedAt: '2026-04-08T18:30:00.000Z',
        userMessage: 'no passata, use cherry tomatoes instead',
        changes: [
          {
            kind: 'replace',
            from: 'passata',
            to: 'cherry tomatoes',
            fromAmount: 200,
            fromUnit: 'g',
            toAmount: 150,
            toUnit: 'g',
          },
        ],
        resultingMacros: { calories: 720, protein: 48, fat: 28, carbs: 72 },
      },
    ],
  };
}
