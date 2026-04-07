/**
 * Scenario 012 — replan a future session then abandon (D27 save-before-destroy guarantee).
 *
 * Same initial state as 011: session A running, session B future-only.
 * User taps Plan Week → gets "Replan it?" → confirms → enters the draft
 * → taps /cancel instead of Approve.
 *
 * The critical assertion: session B is STILL intact after abandonment.
 * superseded = false, batches still status = 'planned'. The save-before-destroy
 * guarantee means the old session is never touched until the new one is fully saved.
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
  flexSlots: [],
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
    scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' as const }],
    status: 'planned',
    createdInPlanSessionId: sessionB.id,
  },
];

export default defineScenario({
  name: '012-rolling-replan-abandon',
  description: 'Start replan then cancel — old session B stays intact (save-before-destroy)',
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
    // Gets "Replan it?" prompt — confirm to enter draft
    click('plan_replan_confirm'),
    // Now in the draft — cancel instead of completing
    command('cancel'),
  ],
});
