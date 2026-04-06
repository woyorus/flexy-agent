/**
 * Unit tests for `TestStateStore` query semantics.
 *
 * These tests verify that the in-memory harness store reproduces the
 * production `StateStore` filter predicates exactly. They are NOT parity
 * tests against the real Supabase class — that would require either
 * module-level mocking of `@supabase/supabase-js` or a DI refactor of
 * `StateStore` (both out of scope for plan 006; tracked in tech-debt).
 *
 * Instead, each test encodes the behavior documented at the referenced
 * `src/state/store.ts` line and asserts `TestStateStore` matches it.
 * Drift between the two implementations surfaces here first.
 *
 * Run via `npm test` — discovered automatically by
 * `test/scenarios.test.ts` alongside scenario replays.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestStateStore } from '../../src/harness/test-store.js';
import type { WeeklyPlan, PlanSession, Batch, Macros, MacrosWithFatCarbs, DraftPlanSession } from '../../src/models/types.js';

/**
 * Build a minimal plan for seeding the store. Only fields used by filter
 * predicates are realistic; the rest are placeholders.
 */
function makePlan(id: string, weekStart: string, status: WeeklyPlan['status']): WeeklyPlan {
  return {
    id,
    weekStart,
    status,
    targets: { calories: 17052, protein: 1050 },
    flexBudget: { treatBudget: 853, flexSlotCalories: 350, flexSlots: [] },
    breakfast: { locked: true, recipeSlug: 'test-breakfast', caloriesPerDay: 650, proteinPerDay: 40 },
    events: [],
    cookDays: [],
    mealSlots: [],
    customShoppingItems: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('TestStateStore.getCurrentPlan returns the more recent of active + planning', async () => {
  // Production filter: `status in ['active', 'planning']` ORDER BY weekStart DESC.
  // Source: src/state/store.ts:70-82.
  const store = new TestStateStore({
    plans: [
      makePlan('older', '2026-03-30', 'active'),
      makePlan('newer', '2026-04-06', 'planning'),
    ],
  });
  const current = await store.getCurrentPlan();
  assert.equal(current?.id, 'newer', 'should return the planning plan with later weekStart');
});

test('TestStateStore.getCurrentPlan ignores completed plans', async () => {
  // Completed plans are excluded from the dual-status filter.
  const store = new TestStateStore({
    plans: [
      makePlan('a', '2026-03-16', 'completed'),
      makePlan('b', '2026-03-23', 'completed'),
      makePlan('c', '2026-03-30', 'active'),
    ],
  });
  const current = await store.getCurrentPlan();
  assert.equal(current?.id, 'c', 'should return the only active plan despite completed plans being newer-looking');
});

test('TestStateStore.getCurrentPlan returns null when no active or planning plans exist', async () => {
  const store = new TestStateStore({
    plans: [makePlan('a', '2026-03-30', 'completed')],
  });
  const current = await store.getCurrentPlan();
  assert.equal(current, null);
});

test('TestStateStore.getLastCompletedPlan returns only completed plans, newest first', async () => {
  // Source: src/state/store.ts:87-99 — status === 'completed', weekStart DESC, limit 1.
  const store = new TestStateStore({
    plans: [
      makePlan('older', '2026-03-16', 'completed'),
      makePlan('newer', '2026-03-23', 'completed'),
      makePlan('active', '2026-04-06', 'active'),
    ],
  });
  const last = await store.getLastCompletedPlan();
  assert.equal(last?.id, 'newer');
});

test('TestStateStore.getRecentCompletedPlans returns up to N completed plans, newest first', async () => {
  // Source: src/state/store.ts:107-118 — status === 'completed', weekStart DESC, limit N.
  const store = new TestStateStore({
    plans: [
      makePlan('a', '2026-03-02', 'completed'),
      makePlan('b', '2026-03-09', 'completed'),
      makePlan('c', '2026-03-16', 'completed'),
    ],
  });
  const recent = await store.getRecentCompletedPlans(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.id, 'c', 'most recent first');
  assert.equal(recent[1]?.id, 'b', 'second most recent');
});

test('TestStateStore.completeActivePlans flips every active plan to completed', async () => {
  // Source: src/state/store.ts:124-134 — UPDATE ... SET status='completed' WHERE status='active'.
  // Important: planning-status plans are NOT affected (matches prod).
  const store = new TestStateStore({
    plans: [
      makePlan('a', '2026-03-30', 'active'),
      makePlan('b', '2026-04-06', 'active'),
      makePlan('c', '2026-04-13', 'planning'),
    ],
  });
  await store.completeActivePlans();
  const snap = store.snapshot();
  const byId = new Map(snap.plans.map((p) => [p.id, p.status]));
  assert.equal(byId.get('a'), 'completed');
  assert.equal(byId.get('b'), 'completed');
  assert.equal(byId.get('c'), 'planning', 'planning-status plans are untouched');
});

test('TestStateStore.savePlan upserts by id', async () => {
  const store = new TestStateStore();
  await store.savePlan(makePlan('x', '2026-04-06', 'planning'));
  assert.equal(store.snapshot().plans.length, 1);

  // Upsert same id with a new status — length stays 1, status updates.
  await store.savePlan(makePlan('x', '2026-04-06', 'active'));
  assert.equal(store.snapshot().plans.length, 1);
  assert.equal(store.snapshot().plans[0]?.status, 'active');
});

test('TestStateStore seed data is isolated from caller mutations', async () => {
  // Deep-clone guarantee: mutating the seed plan after construction must
  // not leak into the store's internal state.
  const seed = makePlan('a', '2026-04-06', 'planning');
  const store = new TestStateStore({ plans: [seed] });
  seed.status = 'completed';
  const snap = store.snapshot();
  assert.equal(snap.plans[0]?.status, 'planning', 'store should hold a deep clone of seed');
});

test('TestStateStore.snapshot.currentPlan matches getCurrentPlan behavior', async () => {
  const store = new TestStateStore({
    plans: [
      makePlan('done', '2026-03-23', 'completed'),
      makePlan('active', '2026-03-30', 'active'),
      makePlan('planning', '2026-04-06', 'planning'),
    ],
  });
  const snap = store.snapshot();
  assert.equal(snap.currentPlan?.id, 'planning', 'snapshot currentPlan applies the same filter as getCurrentPlan');
  assert.equal(snap.plans.length, 3, 'snapshot.plans is unfiltered');
});

// ─── Plan 007: Rolling-horizon store tests ──────────────────────────────────

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
