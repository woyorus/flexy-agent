/**
 * Scenario 010 — events + pre-committed slots + flex in the same horizon.
 *
 * Tests that the proposer handles all three constraint types simultaneously:
 * - Pre-committed lunch slots from session A (days 1-2)
 * - A restaurant event on day 3 dinner
 * - The standard flex slot
 *
 * The proposer must plan around all three: no double-booking pre-committed,
 * no overlapping the event, exactly 1 flex slot.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';
import type { PlanSession, Batch } from '../../../src/models/types.js';

// Session A: Apr 6-12, with a lunch batch that extends to Apr 13-14
const sessionA: PlanSession = {
  id: 'session-a-events-00000000-0000-0000-0000-000000000001',
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

// Last lunch batch extends 2 days into session B
const batchesA: Batch[] = [
  {
    id: 'batch-a-lunch-carry-00000000-0000-0000-0000-000000000001',
    recipeSlug: 'chicken-black-bean-avocado-rice-bowl',
    mealType: 'lunch',
    eatingDays: ['2026-04-12', '2026-04-13', '2026-04-14'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 55 },
    actualPerServing: { calories: 792, protein: 57, fat: 27, carbs: 80 },
    scaledIngredients: [{ name: 'chicken breast', amount: 190, unit: 'g', totalForBatch: 570, role: 'protein' as const }],
    status: 'planned',
    createdInPlanSessionId: sessionA.id,
  },
];

export default defineScenario({
  name: '010-rolling-events-with-carryover',
  description: 'Events + pre-committed carry-over + flex in one horizon — all three constraint types at once',
  // Clock: Apr 12, session A running. Next horizon = Apr 13-19.
  // Pre-committed: lunch on Apr 13 + Apr 14 (chicken-black-bean)
  // Event: dinner on Wed Apr 15
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
    // Add a restaurant event
    click('plan_add_event'),
    text('Dinner with friends on Wednesday, about 900 calories'),
    click('plan_events_done'),
    click('plan_approve'),
  ],
});
