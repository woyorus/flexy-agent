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
import type { WeeklyPlan } from '../../src/models/types.js';

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
