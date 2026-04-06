/**
 * Scenario 011 — replan a future-only session (D27 happy path).
 *
 * Session A is running (Apr 6-12). Session B is future-only (Apr 13-19).
 * User taps Plan Week → gets "Replan it?" prompt → confirms → completes
 * a new plan for Apr 13-19 → old session B is superseded, new session C
 * takes its place.
 *
 * Verifies:
 * - "Replan it?" prompt appears with correct date range
 * - Confirming starts a fresh planning flow for the same horizon
 * - Breakfast inherited from session B (the one being replaced)
 * - On approve, confirmPlanSessionReplacing runs: new session + batches
 *   saved, old B's batches cancelled, old B superseded
 * - Final store: A (running, untouched), B (superseded), C (live)
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const sessionA: PlanSession = {
  id: 'session-a-run-00000000-0000-0000-0000-000000000001',
  horizonStart: '2026-04-06',
  horizonEnd: '2026-04-12',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 658,
    proteinPerDay: 41,
  },
  treatBudgetCalories: 853,
  flexSlots: [],
  events: [],
  confirmedAt: '2026-04-05T10:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-05T10:00:00.000Z',
  updatedAt: '2026-04-05T10:00:00.000Z',
};

const sessionB: PlanSession = {
  id: 'session-b-future-00000000-0000-0000-0000-000000000002',
  horizonStart: '2026-04-13',
  horizonEnd: '2026-04-19',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 658,
    proteinPerDay: 41,
  },
  treatBudgetCalories: 853,
  flexSlots: [{ day: '2026-04-17', mealTime: 'dinner' as const, flexBonus: 350, note: 'flex' }],
  events: [],
  confirmedAt: '2026-04-06T10:00:00.000Z',
  superseded: false,
  createdAt: '2026-04-06T10:00:00.000Z',
  updatedAt: '2026-04-06T10:00:00.000Z',
};

const batchesB: Batch[] = [
  {
    id: 'batch-b1-00000000-0000-0000-0000-000000000003',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-13', '2026-04-14', '2026-04-15'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 792, protein: 57, fat: 27, carbs: 80 },
    scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570 }],
    status: 'planned',
    createdInPlanSessionId: sessionB.id,
  },
  {
    id: 'batch-b2-00000000-0000-0000-0000-000000000004',
    recipeSlug: 'ground-beef-rigatoni-bolognese',
    mealType: 'dinner',
    eatingDays: ['2026-04-13', '2026-04-14'],
    servings: 2,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 810, protein: 55, fat: 32, carbs: 70 },
    scaledIngredients: [{ name: 'ground beef', amount: 200, unit: 'g', totalForBatch: 400 }],
    status: 'planned',
    createdInPlanSessionId: sessionB.id,
  },
];

export default defineScenario({
  name: '011-rolling-replan-future-only',
  description: 'Replan a future-only session — D27 save-before-destroy happy path',
  // Clock: Apr 8 (Wednesday). Session A is running (Apr 6-12), session B is future (Apr 13-19).
  clock: '2026-04-08T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [sessionA, sessionB],
    batches: batchesB,
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    // Should get "Replan it?" prompt
    click('plan_replan_confirm'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
