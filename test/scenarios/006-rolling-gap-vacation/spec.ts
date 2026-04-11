/**
 * Scenario 006 — rolling gap (vacation fallback).
 *
 * Tests the "tomorrow" fallback when there's a gap between plan sessions.
 * Session A ended days ago; the user comes back after a break and taps Plan Week.
 * computeNextHorizonStart should fall back to "tomorrow" since there's no
 * running or future session — just a historical one.
 *
 * No carry-over expected (session A's horizon ended before today).
 * Breakfast falls back to the historical session's breakfast.
 */

import { defineScenario, command, text, click } from '../../../src/harness/define.js';
import type { PlanSession } from '../../../src/models/types.js';

// Session A: ended Apr 5 (historical — horizonEnd < today)
const sessionA: PlanSession = {
  id: 'session-a-hist-00000000-0000-0000-0000-000000000001',
  horizonStart: '2026-03-30',
  horizonEnd: '2026-04-05',
  breakfast: {
    locked: true,
    recipeSlug: 'salmon-avocado-toast-soft-eggs-cinnamon-yogurt',
    caloriesPerDay: 658,
    proteinPerDay: 41,
  },
  treatBudgetCalories: 853,
  flexSlots: [],
  events: [],
  mutationHistory: [],
  confirmedAt: '2026-03-29T10:00:00.000Z',
  superseded: false,
  createdAt: '2026-03-29T10:00:00.000Z',
  updatedAt: '2026-03-29T10:00:00.000Z',
};

export default defineScenario({
  name: '006-rolling-gap-vacation',
  description: 'User returns after a vacation gap — horizon starts tomorrow, no carry-over',
  // Clock: Apr 9 (Wednesday). Session A ended Apr 5 — 4-day gap.
  // computeNextHorizonStart: no running, no future → tomorrow = Apr 10
  clock: '2026-04-09T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    planSessions: [sessionA],
    batches: [], // Session A's batches don't matter — they're fully in the past
  },
  events: [
    command('start'),
    text('📋 Plan Week'),
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
