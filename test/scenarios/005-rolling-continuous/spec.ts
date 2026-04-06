/**
 * Scenario 005 — rolling continuous planning with carry-over.
 *
 * Exercises the core rolling-horizon behavior: session A is already confirmed,
 * and session B plans the next 7 days. Session A's last batch extends into
 * session B's horizon (cross-horizon carry-over), so the proposer must plan
 * around pre-committed slots.
 *
 * The scenario verifies:
 * - computeNextHorizonStart picks up where session A left off
 * - Pre-committed slots from A appear in the proposer's prompt
 * - The proposer does NOT double-book pre-committed (day, mealTime)
 * - Budget math subtracts carry-over calories
 * - Final store has 2 plan sessions and batches from both
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

// Session A: Apr 6–12 (already confirmed and "running")
const sessionA: PlanSession = {
  id: 'session-a-00000000-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 658,
    proteinPerDay: 41,
  },
  treatBudgetCalories: 853,
  flexSlots: [{ day: '2026-04-10', mealTime: 'dinner' as const, flexBonus: 350, note: 'flex dinner' }],
  events: [],
  confirmedAt: '2026-04-05T10:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-05T10:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
};

// Session A's batches — the last dinner batch extends into session B's horizon
const batchesA: Batch[] = [
  {
    id: 'batch-a1-lunch-00000000-0000-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 792, protein: 57, fat: 27, carbs: 80 },
    scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
  {
    id: 'batch-a2-lunch-00000000-0000-0000-0000-000000000002',
    recipeSlug: 'soy-ginger-pork-rice-bowls-broccoli-carrots-scallions',
    mealType: 'lunch',
    eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 805, protein: 56, fat: 28, carbs: 78 },
    scaledIngredients: [{ name: 'pork tenderloin', amount: 180, unit: 'g', totalForBatch: 540 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
  {
    id: 'batch-a3-lunch-00000000-0000-0000-0000-000000000003',
    recipeSlug: 'mediterranean-tuna-chickpea-feta-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-12'],
    servings: 1,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 798, protein: 54, fat: 30, carbs: 75 },
    scaledIngredients: [{ name: 'tuna', amount: 150, unit: 'g', totalForBatch: 150 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
  {
    id: 'batch-a4-dinner-00000000-0000-0000-0000-000000000004',
    recipeSlug: 'creamy-salmon-and-shrimp-linguine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07'],
    servings: 2,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 800, protein: 56, fat: 30, carbs: 72 },
    scaledIngredients: [{ name: 'salmon fillet', amount: 160, unit: 'g', totalForBatch: 320 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
  {
    id: 'batch-a5-dinner-00000000-0000-0000-0000-000000000005',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'dinner',
    eatingDays: ['2026-04-08', '2026-04-09'],
    servings: 2,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 810, protein: 55, fat: 32, carbs: 70 },
    scaledIngredients: [{ name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 400 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
  {
    // This batch CROSSES into session B's horizon (Apr 11-12-13)
    id: 'batch-a6-dinner-00000000-0000-0000-0000-000000000006',
    recipeSlug: 'moroccan-beef-tagine-style-skillet-with-lemon-couscous',
    mealType: 'dinner',
    eatingDays: ['2026-04-11', '2026-04-12', '2026-04-13'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 808, protein: 56, fat: 29, carbs: 76 },
    scaledIngredients: [{ name: 'beef stew meat', amount: 180, unit: 'g', totalForBatch: 540 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
];

export default defineScenario({
  name: '005-rolling-continuous',
  description: 'Session B plans around pre-committed carry-over from session A (cross-horizon dinner batch)',
  // Clock is set to Apr 12 (Saturday) — session A is "running" (Apr 6-12 contains today)
  // computeNextHorizonStart should return Apr 13 (day after session A ends)
  clock: '2026-04-12T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [sessionA],
    batches: batchesA,
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
