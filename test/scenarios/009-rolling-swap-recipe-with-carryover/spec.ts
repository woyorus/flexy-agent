/**
 * Scenario 009 — recipe swap with pre-committed carry-over.
 *
 * Session B has pre-committed slots from session A. The user performs a
 * recipe_swap on a non-pre-committed batch. Verifies that the swap:
 * - Succeeds on the user's own batch
 * - Does NOT touch pre-committed slots
 * - Re-runs the solver correctly with carry-over still in place
 */
import { defineScenario, command, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

const sessionA: PlanSession = {
  id: 'session-a-swap-00000000-0000-0000-0000-000000000001',
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

// Lunch batch extends 1 day into session B
const batchesA: Batch[] = [
  {
    id: 'batch-a-lunch-swap-00000000-0000-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-12', '2026-04-13'],
    servings: 2,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 792, protein: 57, fat: 27, carbs: 80 },
    scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 380 }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
];

export default defineScenario({
  name: '009-rolling-swap-recipe-with-carryover',
  description: 'Recipe swap on a non-pre-committed batch — carry-over stays intact',
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
    click('plan_swap'),
    text('Swap the tuna lunch for something with pork'),
    click('plan_approve'),
  ],
});
