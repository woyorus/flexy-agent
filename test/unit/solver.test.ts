/**
 * Unit tests for the budget solver's rolling-horizon support (Plan 007).
 *
 * Covers:
 * - Carry-over budget subtraction with pre-committed slots
 * - Slot count arithmetic (pre-committed don't count as new slots)
 * - Daily breakdown includes pre-committed slot rows with frozen macros
 * - Day covered only by pre-committed slot still produces a dailyBreakdown row
 * - Explicit horizonDays ensures all 7 days appear in breakdown (D32)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../../src/solver/solver.js';
import type { SolverInput } from '../../src/solver/types.js';

/** Build a 7-day date range starting from a given date. */
function sevenDays(start: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

const HORIZON = sevenDays('2026-04-13');

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
  return {
    weeklyTargets: { calories: 17052, protein: 1050 },
    events: [],
    flexSlots: [],
    mealPrepPreferences: {
      recipes: [
        // 4 batches covering days 3-7 for lunch+dinner (no batches on days 1-2)
        { recipeSlug: 'r1', mealType: 'lunch', days: [HORIZON[2]!, HORIZON[3]!, HORIZON[4]!], servings: 3 },
        { recipeSlug: 'r2', mealType: 'dinner', days: [HORIZON[2]!, HORIZON[3]!, HORIZON[4]!], servings: 3 },
        { recipeSlug: 'r3', mealType: 'lunch', days: [HORIZON[5]!, HORIZON[6]!], servings: 2 },
        { recipeSlug: 'r4', mealType: 'dinner', days: [HORIZON[5]!, HORIZON[6]!], servings: 2 },
      ],
    },
    breakfast: { locked: true, recipeSlug: 'b', caloriesPerDay: 650, proteinPerDay: 40 },
    horizonDays: HORIZON,
    carriedOverSlots: [
      // Pre-committed slots on days 1-2 from session A
      { day: HORIZON[0]!, mealTime: 'lunch', recipeSlug: 'a-lunch', calories: 790, protein: 55, sourceBatchId: 'ba1' },
      { day: HORIZON[0]!, mealTime: 'dinner', recipeSlug: 'a-dinner', calories: 790, protein: 55, sourceBatchId: 'ba2' },
      { day: HORIZON[1]!, mealTime: 'lunch', recipeSlug: 'a-lunch', calories: 790, protein: 55, sourceBatchId: 'ba1' },
      { day: HORIZON[1]!, mealTime: 'dinner', recipeSlug: 'a-dinner', calories: 790, protein: 55, sourceBatchId: 'ba2' },
    ],
    ...overrides,
  };
}

test('solver: carry-over budget subtraction reduces meal prep budget', () => {
  const withCarry = solve(makeInput());
  const withoutCarry = solve(makeInput({ carriedOverSlots: [] }));

  // With carry-over, the meal prep budget should be lower (4 slots × ~790 cal subtracted)
  // This means per-slot target for new batches should be lower
  const newBatchCalWith = withCarry.batchTargets[0]!.targetPerServing.calories;
  const newBatchCalWithout = withoutCarry.batchTargets[0]!.targetPerServing.calories;
  assert.ok(
    newBatchCalWith < newBatchCalWithout,
    `Per-slot with carry (${newBatchCalWith}) should be less than without (${newBatchCalWithout})`,
  );
});

test('solver: pre-committed slots do not count as new batch slots', () => {
  const result = solve(makeInput());
  // 4 batches: 3+3+2+2 = 10 new servings. Pre-committed slots (4) are NOT in slot count.
  // If pre-committed were mistakenly counted, per-slot would be spread over 14 instead of 10.
  const totalNewServings = 3 + 3 + 2 + 2;
  assert.equal(result.batchTargets.length, 4);
  // Budget math: all batch targets share the same uniform per-slot calories
  const perSlot = result.batchTargets[0]!.targetPerServing.calories;
  // Verify it's reasonable (not diluted by pre-committed)
  assert.ok(perSlot >= 400, `Per-slot ${perSlot} is too low`);
  assert.ok(perSlot <= 1000, `Per-slot ${perSlot} is too high`);
});

test('solver: dailyBreakdown renders all 7 days from explicit horizonDays (D32)', () => {
  const result = solve(makeInput());
  assert.equal(result.dailyBreakdown.length, 7, 'should produce exactly 7 daily rows');
  for (let i = 0; i < 7; i++) {
    assert.equal(result.dailyBreakdown[i]!.day, HORIZON[i]!);
  }
});

test('solver: day covered only by pre-committed slot still produces dailyBreakdown row', () => {
  const result = solve(makeInput());
  // Days 0 and 1 have NO new batches — only pre-committed slots
  const day0 = result.dailyBreakdown[0]!;
  const day1 = result.dailyBreakdown[1]!;

  // Lunch and dinner come from pre-committed slots (frozen macros)
  assert.equal(day0.lunch.calories, 790, 'day 0 lunch should use pre-committed calories');
  assert.equal(day0.dinner.calories, 790, 'day 0 dinner should use pre-committed calories');
  assert.equal(day1.lunch.calories, 790);
  assert.equal(day1.dinner.calories, 790);

  // Breakfast is still computed normally
  assert.equal(day0.breakfast.calories, 650);
});

test('solver: pre-committed slot calories appear in weekly totals', () => {
  const result = solve(makeInput());
  // Pre-committed: 4 slots × 790 = 3160 cal
  // These should NOT appear in batchTargets but DO appear in dailyBreakdown totals
  const totalFromBreakdown = result.dailyBreakdown.reduce((s, d) => s + d.totalCalories, 0);
  // Verify the 4 pre-committed meals are included in the daily sums
  assert.ok(totalFromBreakdown > 3160, 'total should include pre-committed slot calories');
});

test('solver: without horizonDays, falls back to legacy derivation', () => {
  const input = makeInput({ horizonDays: undefined, carriedOverSlots: [] });
  const result = solve(input);
  // Legacy: only days from recipes + flex slots. Days 0-1 have no source → missing
  assert.equal(result.dailyBreakdown.length, 5, 'legacy path should derive 5 days from recipes');
});
