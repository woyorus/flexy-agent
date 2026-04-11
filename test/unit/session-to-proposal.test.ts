/**
 * Unit tests for the session-to-proposal adapter (Plan 026).
 *
 * These tests cover the four pure functions exposed by
 * `src/plan/session-to-proposal.ts` in isolation, then the end-to-end
 * round-trip from persisted session to re-proposer-ready proposal and back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Batch } from '../../src/models/types.js';
import { classifySlot, splitBatchAtCutoffs } from '../../src/plan/session-to-proposal.js';

// Fixed clock helpers — tests construct Date objects directly with local time.
// The adapter reads only wall-clock from `now`, never Date.now() or new Date().
function at(isoDate: string, hour: number, minute = 0): Date {
  // Construct in the runtime's local timezone so the adapter's
  // toLocalISODate(now) maps back to `isoDate`. Mirrors how scenarios freeze
  // clocks (see src/harness/clock.ts).
  return new Date(`${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
}

test('classifySlot: date before today is always past for both meal types', () => {
  const now = at('2026-04-07', 10); // Tuesday morning
  assert.equal(classifySlot('2026-04-06', 'lunch', now), 'past');
  assert.equal(classifySlot('2026-04-06', 'dinner', now), 'past');
});

test('classifySlot: date after today is always active for both meal types', () => {
  const now = at('2026-04-07', 23);
  assert.equal(classifySlot('2026-04-08', 'lunch', now), 'active');
  assert.equal(classifySlot('2026-04-08', 'dinner', now), 'active');
});

test('classifySlot: today lunch is active before 15:00', () => {
  assert.equal(classifySlot('2026-04-07', 'lunch', at('2026-04-07', 14, 59)), 'active');
});

test('classifySlot: today lunch is past at 15:00', () => {
  assert.equal(classifySlot('2026-04-07', 'lunch', at('2026-04-07', 15, 0)), 'past');
});

test('classifySlot: today dinner is active at 15:00 (lunch cutoff does not affect dinner)', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 15, 0)), 'active');
});

test('classifySlot: today dinner is active at 20:59', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 20, 59)), 'active');
});

test('classifySlot: today dinner is past at 21:00', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 21, 0)), 'past');
});

function batch(overrides: Partial<Batch>): Batch {
  return {
    id: 'batch-x',
    recipeSlug: 'tagine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 45 },
    actualPerServing: { calories: 810, protein: 46, fat: 30, carbs: 60 },
    scaledIngredients: [
      { name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
    ],
    status: 'planned',
    createdInPlanSessionId: 'sess-1',
    ...overrides,
  };
}

test('splitBatchAtCutoffs: pure past batch — all eating days strictly before today', () => {
  // Now = Thursday 10am. All eating days Mon/Tue/Wed are past.
  const now = at('2026-04-09', 10);
  const b = batch({
    id: 'past-batch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
  if (result.kind !== 'past-only') throw new Error('unreachable');
  assert.deepStrictEqual(result.pastBatch, b);
});

test('splitBatchAtCutoffs: pure active batch — all eating days after today', () => {
  // Now = Monday 10am. Eating days Tue/Wed/Thu all active.
  const now = at('2026-04-06', 10);
  const b = batch({
    id: 'future-batch',
    eatingDays: ['2026-04-07', '2026-04-08', '2026-04-09'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'active-only');
  if (result.kind !== 'active-only') throw new Error('unreachable');
  assert.deepStrictEqual(result.activeBatch, {
    recipeSlug: 'tagine',
    recipeName: 'tagine',
    mealType: 'dinner',
    days: ['2026-04-07', '2026-04-08', '2026-04-09'],
    servings: 3,
    overflowDays: undefined,
  });
});

test('splitBatchAtCutoffs: pure active — today lunch batch before 15:00 stays fully active', () => {
  const now = at('2026-04-07', 10);
  const b = batch({
    id: 'today-lunch',
    mealType: 'lunch',
    eatingDays: ['2026-04-07'],
    servings: 1,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'active-only');
});

test('splitBatchAtCutoffs: pure past — today lunch batch after 15:00 is past', () => {
  const now = at('2026-04-07', 15, 30);
  const b = batch({
    id: 'today-lunch-late',
    mealType: 'lunch',
    eatingDays: ['2026-04-07'],
    servings: 1,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
});
