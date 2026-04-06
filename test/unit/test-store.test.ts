/**
 * Unit tests for `TestStateStore` — rolling-horizon query semantics.
 *
 * Verifies the in-memory store matches production `StateStore` filter
 * predicates for plan sessions and batches. Run via `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestStateStore } from '../../src/harness/test-store.js';
import type { PlanSession, Batch, Macros, MacrosWithFatCarbs, DraftPlanSession } from '../../src/models/types.js';

// ─── Rolling-horizon store tests ────────────────────────────────────────────

const MACROS: Macros = { calories: 800, protein: 55 };
const ACTUAL_MACROS: MacrosWithFatCarbs = { calories: 792, protein: 57, fat: 27, carbs: 80 };

function makeSession(
  id: string,
  horizonStart: string,
  horizonEnd: string,
  overrides: Partial<PlanSession> = {},
): PlanSession {
  return {
    id,
    horizonStart,
    horizonEnd,
    breakfast: { locked: true, recipeSlug: 'test-breakfast', caloriesPerDay: 650, proteinPerDay: 40 },
    treatBudgetCalories: 853,
    flexSlots: [],
    events: [],
    confirmedAt: '2026-04-05T10:00:00.000Z',
    superseded: false,
    createdAt: '2026-04-05T10:00:00.000Z',
    updatedAt: '2026-04-05T10:00:00.000Z',
    ...overrides,
  };
}

function makeBatch(
  id: string,
  sessionId: string,
  eatingDays: string[],
  overrides: Partial<Batch> = {},
): Batch {
  return {
    id,
    recipeSlug: 'test-recipe',
    mealType: 'lunch',
    eatingDays,
    servings: eatingDays.length,
    targetPerServing: MACROS,
    actualPerServing: ACTUAL_MACROS,
    scaledIngredients: [],
    status: 'planned',
    createdInPlanSessionId: sessionId,
    ...overrides,
  };
}

function makeDraft(
  id: string,
  horizonStart: string,
  horizonEnd: string,
): DraftPlanSession {
  return {
    id,
    horizonStart,
    horizonEnd,
    breakfast: { locked: true, recipeSlug: 'test-breakfast', caloriesPerDay: 650, proteinPerDay: 40 },
    treatBudgetCalories: 853,
    flexSlots: [],
    events: [],
  };
}

// ─── Query tests ─────────────────────────────────────────────────────────────

test('getRunningPlanSession returns session whose horizon contains today', async () => {
  const store = new TestStateStore({
    planSessions: [
      makeSession('past', '2026-03-30', '2026-04-05'),
      makeSession('running', '2026-04-06', '2026-04-12'),
      makeSession('future', '2026-04-13', '2026-04-19'),
    ],
  });
  store.setToday('2026-04-08');
  const running = await store.getRunningPlanSession();
  assert.equal(running?.id, 'running');
});

test('getRunningPlanSession excludes superseded sessions', async () => {
  const store = new TestStateStore({
    planSessions: [
      makeSession('old', '2026-04-06', '2026-04-12', { superseded: true }),
    ],
  });
  store.setToday('2026-04-08');
  assert.equal(await store.getRunningPlanSession(), null);
});

test('getFuturePlanSessions returns sessions starting after today, earliest first', async () => {
  const store = new TestStateStore({
    planSessions: [
      makeSession('running', '2026-04-06', '2026-04-12'),
      makeSession('far', '2026-04-20', '2026-04-26'),
      makeSession('near', '2026-04-13', '2026-04-19'),
    ],
  });
  store.setToday('2026-04-08');
  const future = await store.getFuturePlanSessions();
  assert.equal(future.length, 2);
  assert.equal(future[0]?.id, 'near');
  assert.equal(future[1]?.id, 'far');
});

test('getFuturePlanSessions excludes superseded sessions', async () => {
  const store = new TestStateStore({
    planSessions: [
      makeSession('future', '2026-04-13', '2026-04-19', { superseded: true }),
      makeSession('future2', '2026-04-20', '2026-04-26'),
    ],
  });
  store.setToday('2026-04-08');
  const future = await store.getFuturePlanSessions();
  assert.equal(future.length, 1);
  assert.equal(future[0]?.id, 'future2');
});

test('getLatestHistoricalPlanSession returns the most recent fully-ended session', async () => {
  const store = new TestStateStore({
    planSessions: [
      makeSession('old', '2026-03-23', '2026-03-29'),
      makeSession('recent', '2026-03-30', '2026-04-05'),
      makeSession('running', '2026-04-06', '2026-04-12'),
    ],
  });
  store.setToday('2026-04-08');
  const hist = await store.getLatestHistoricalPlanSession();
  assert.equal(hist?.id, 'recent');
});

test('getRecentPlanSessions returns all non-superseded sessions ordered by horizon_end DESC', async () => {
  const store = new TestStateStore({
    planSessions: [
      makeSession('a', '2026-03-23', '2026-03-29'),
      makeSession('b', '2026-03-30', '2026-04-05'),
      makeSession('c', '2026-04-06', '2026-04-12'),
      makeSession('d', '2026-04-13', '2026-04-19', { superseded: true }),
    ],
  });
  const recent = await store.getRecentPlanSessions(3);
  assert.equal(recent.length, 3);
  assert.equal(recent[0]?.id, 'c');
  assert.equal(recent[1]?.id, 'b');
  assert.equal(recent[2]?.id, 'a');
});

// ─── getBatchesOverlapping tests ─────────────────────────────────────────────

test('getBatchesOverlapping returns batches whose eating_days intersect the horizon', async () => {
  const sessionA = makeSession('sA', '2026-04-06', '2026-04-12');
  const store = new TestStateStore({
    planSessions: [sessionA],
    batches: [
      makeBatch('b1', 'sA', ['2026-04-06', '2026-04-07', '2026-04-08']),
      makeBatch('b2', 'sA', ['2026-04-11', '2026-04-12', '2026-04-13']), // crosses into next horizon
      makeBatch('b3', 'sA', ['2026-04-14', '2026-04-15']), // fully outside
    ],
  });

  // Query for a horizon that overlaps with b1 and b2 but not b3
  const result = await store.getBatchesOverlapping({
    horizonStart: '2026-04-13',
    horizonEnd: '2026-04-19',
    statuses: ['planned'],
  });
  assert.equal(result.length, 2);
  const ids = result.map((b) => b.id).sort();
  assert.deepStrictEqual(ids, ['b2', 'b3']);
});

test('getBatchesOverlapping respects status filter', async () => {
  const store = new TestStateStore({
    planSessions: [makeSession('sA', '2026-04-06', '2026-04-12')],
    batches: [
      makeBatch('b1', 'sA', ['2026-04-06', '2026-04-07'], { status: 'planned' }),
      makeBatch('b2', 'sA', ['2026-04-08', '2026-04-09'], { status: 'cancelled' }),
    ],
  });
  const planned = await store.getBatchesOverlapping({
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    statuses: ['planned'],
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0]?.id, 'b1');
});

// ─── confirmPlanSession tests ────────────────────────────────────────────────

test('confirmPlanSession inserts session and batches atomically', async () => {
  const store = new TestStateStore();
  const draft = makeDraft('s1', '2026-04-13', '2026-04-19');
  const batches = [
    { ...makeBatch('b1', 's1', ['2026-04-13', '2026-04-14', '2026-04-15']) },
    { ...makeBatch('b2', 's1', ['2026-04-16', '2026-04-17']) },
  ];

  const result = await store.confirmPlanSession(draft, batches);
  assert.equal(result.id, 's1');
  assert.equal(result.superseded, false);
  assert.ok(result.confirmedAt);

  const snap = store.snapshot();
  assert.equal(snap.planSessions.length, 1);
  assert.equal(snap.batches.length, 2);
  assert.equal(snap.batches[0]?.createdInPlanSessionId, 's1');
});

// ─── confirmPlanSessionReplacing tests ───────────────────────────────────────

test('confirmPlanSessionReplacing implements save-before-destroy ordering', async () => {
  // Seed: session A (running) + session B (future, about to be replaced)
  const store = new TestStateStore({
    planSessions: [
      makeSession('sA', '2026-04-06', '2026-04-12'),
      makeSession('sB', '2026-04-13', '2026-04-19'),
    ],
    batches: [
      makeBatch('bA1', 'sA', ['2026-04-06', '2026-04-07']),
      makeBatch('bB1', 'sB', ['2026-04-13', '2026-04-14', '2026-04-15']),
      makeBatch('bB2', 'sB', ['2026-04-16', '2026-04-17']),
    ],
  });

  // Replace B with new session C
  const draftC = makeDraft('sC', '2026-04-13', '2026-04-19');
  const newBatches = [
    { ...makeBatch('bC1', 'sC', ['2026-04-13', '2026-04-14', '2026-04-15']) },
  ];

  const result = await store.confirmPlanSessionReplacing(draftC, newBatches, 'sB');

  // Verify: new session is live
  assert.equal(result.id, 'sC');
  assert.equal(result.superseded, false);

  // Verify: old session B is superseded
  const oldB = await store.getPlanSession('sB');
  assert.equal(oldB?.superseded, true);

  // Verify: old B's batches are cancelled
  const batchesB = await store.getBatchesByPlanSessionId('sB');
  assert.ok(batchesB.every((b) => b.status === 'cancelled'));

  // Verify: new C's batches are planned
  const batchesC = await store.getBatchesByPlanSessionId('sC');
  assert.equal(batchesC.length, 1);
  assert.equal(batchesC[0]?.status, 'planned');

  // Verify: session A is untouched
  const sessionA = await store.getPlanSession('sA');
  assert.equal(sessionA?.superseded, false);
  const batchesA = await store.getBatchesByPlanSessionId('sA');
  assert.ok(batchesA.every((b) => b.status === 'planned'));
});

test('confirmPlanSessionReplacing: superseded session excluded from queries', async () => {
  const store = new TestStateStore({
    planSessions: [makeSession('sB', '2026-04-13', '2026-04-19')],
    batches: [makeBatch('bB1', 'sB', ['2026-04-13', '2026-04-14'])],
  });
  store.setToday('2026-04-08');

  // Before replace: future session is visible
  assert.equal((await store.getFuturePlanSessions()).length, 1);

  // Replace it
  await store.confirmPlanSessionReplacing(
    makeDraft('sC', '2026-04-13', '2026-04-19'),
    [{ ...makeBatch('bC1', 'sC', ['2026-04-13', '2026-04-14']) }],
    'sB',
  );

  // After replace: only new session visible in future queries
  const future = await store.getFuturePlanSessions();
  assert.equal(future.length, 1);
  assert.equal(future[0]?.id, 'sC');

  // Superseded session excluded from recent as well
  const recent = await store.getRecentPlanSessions(10);
  assert.ok(!recent.some((s) => s.id === 'sB'));
});
