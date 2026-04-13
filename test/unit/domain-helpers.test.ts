/**
 * Unit coverage for the planning domain helpers.
 *
 * Builds small hand-shaped `AssertionsContext` values through
 * `buildAssertionsContext` and exercises each primitive's positive +
 * negative case, plus `assertPlanningHealthy`'s aggregation behavior.
 *
 * The tests deliberately do NOT reach into the real runner — every primitive
 * is a pure function over `ctx`, so a minimal hand-built context is enough
 * to cover it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPlanningHealthy,
  assertSlotCoverage,
  assertNoGhostBatches,
  assertNoOrphanSlots,
  assertNoDoubleBooking,
  assertBatchSizesSane,
  assertCookDayFirstEating,
  assertWeeklyTotalsAbsorbed,
} from '../../src/harness/domain-helpers.js';
import { buildAssertionsContext } from '../../src/harness/assertions-context.js';
import type { Scenario, CapturedOutput } from '../../src/harness/types.js';
import type { ExecTrace } from '../../src/harness/trace.js';

const EMPTY_TRACE: ExecTrace = {
  handlers: [],
  dispatcherActions: [],
  validatorRetries: [],
  persistenceOps: [],
};

const FAKE_SPEC: Scenario = {
  name: 'fake',
  description: '',
  clock: '2026-04-06T10:00:00Z',
  recipeSet: 'none',
  initialState: {},
  events: [],
};

function buildFullCoverageBatches(horizonStart: string) {
  // Horizon: 2026-04-06 .. 2026-04-12 (7 days). 14 lunch+dinner slots.
  // Two 3-serving lunch batches + three 3-serving+2-serving dinner batches
  // is brittle; simpler: single batch per slot.
  const days: string[] = [];
  const start = new Date(horizonStart + 'T00:00:00Z');
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const batches = [];
  for (const day of days) {
    for (const meal of ['lunch', 'dinner'] as const) {
      batches.push({
        id: `batch-${day}-${meal}`,
        recipeSlug: `r-${day}-${meal}`,
        mealType: meal,
        eatingDays: [day],
        servings: 1,
        status: 'planned' as const,
        createdInPlanSessionId: 'session-a',
        actualPerServing: { calories: 600 },
      });
    }
  }
  return batches;
}

function buildCtx(finalStore: unknown, outputs: CapturedOutput[] = []) {
  return buildAssertionsContext({
    spec: FAKE_SPEC,
    outputs,
    finalSession: null,
    finalStore,
    execTrace: EMPTY_TRACE,
  });
}

function buildPlanningStore(horizonStart = '2026-04-06', horizonEnd = '2026-04-12') {
  return {
    session: null,
    planSessions: [
      {
        id: 'session-a',
        horizonStart,
        horizonEnd,
        breakfast: { locked: true, recipeSlug: 'oats', caloriesPerDay: 400, proteinPerDay: 20 },
        treatBudgetCalories: 0,
        flexSlots: [],
        events: [],
        mutationHistory: [],
        confirmedAt: '2026-04-06T10:00:00Z',
        superseded: false,
        supersededBy: null,
        createdAt: '2026-04-06T10:00:00Z',
        updatedAt: '2026-04-06T10:00:00Z',
      },
    ],
    batches: buildFullCoverageBatches(horizonStart),
    measurements: [],
  };
}

// ─── assertSlotCoverage ─────────────────────────────────────────────────────

test('assertSlotCoverage passes on a fully covered horizon', () => {
  assert.doesNotThrow(() => assertSlotCoverage(buildCtx(buildPlanningStore())));
});

test('assertSlotCoverage no-op on non-planning scenario (no active session)', () => {
  assert.doesNotThrow(() =>
    assertSlotCoverage(buildCtx({ session: null, planSessions: [], batches: [] })),
  );
});

test('assertSlotCoverage flags orphan slots', () => {
  const store = buildPlanningStore();
  // Remove lunch batch for 2026-04-06
  store.batches = store.batches.filter(
    (b) => !(b.eatingDays[0] === '2026-04-06' && b.mealType === 'lunch'),
  );
  assert.throws(
    () => assertSlotCoverage(buildCtx(store)),
    /slot 2026-04-06:lunch has no source/,
  );
});

test('assertSlotCoverage flags double-booked slots', () => {
  const store = buildPlanningStore();
  // Add a flex slot on the same day+meal as an existing batch
  const active = store.planSessions[0]!;
  active.flexSlots = [{ day: '2026-04-06', mealTime: 'lunch' }];
  assert.throws(
    () => assertSlotCoverage(buildCtx(store)),
    /double-booked/,
  );
});

// ─── assertNoGhostBatches ───────────────────────────────────────────────────

test('assertNoGhostBatches passes on non-zero macros', () => {
  assert.doesNotThrow(() => assertNoGhostBatches(buildCtx(buildPlanningStore())));
});

test('assertNoGhostBatches flags zero-calorie batch', () => {
  const store = buildPlanningStore();
  store.batches[0]!.actualPerServing = { calories: 0 };
  assert.throws(() => assertNoGhostBatches(buildCtx(store)), /ghost batch/);
});

test('assertNoGhostBatches ignores cancelled batches', () => {
  const store = buildPlanningStore();
  store.batches[0]!.actualPerServing = { calories: 0 };
  store.batches[0]!.status = 'cancelled';
  assert.doesNotThrow(() => assertNoGhostBatches(buildCtx(store)));
});

// ─── assertNoOrphanSlots / assertNoDoubleBooking (independent exports) ──────

test('assertNoOrphanSlots passes on full coverage', () => {
  assert.doesNotThrow(() => assertNoOrphanSlots(buildCtx(buildPlanningStore())));
});

test('assertNoOrphanSlots flags the missing slot', () => {
  const store = buildPlanningStore();
  store.batches = store.batches.filter(
    (b) => !(b.eatingDays[0] === '2026-04-07' && b.mealType === 'dinner'),
  );
  assert.throws(
    () => assertNoOrphanSlots(buildCtx(store)),
    /2026-04-07:dinner/,
  );
});

test('assertNoDoubleBooking passes on single-sourced slots', () => {
  assert.doesNotThrow(() => assertNoDoubleBooking(buildCtx(buildPlanningStore())));
});

test('assertNoDoubleBooking flags same recipe covering two lunches on one day', () => {
  const store = buildPlanningStore();
  store.batches.push({
    id: 'extra',
    recipeSlug: 'extra',
    mealType: 'lunch',
    eatingDays: ['2026-04-06'],
    servings: 1,
    status: 'planned',
    createdInPlanSessionId: 'session-a',
    actualPerServing: { calories: 500 },
  });
  assert.throws(() => assertNoDoubleBooking(buildCtx(store)), /double-booked/);
});

// ─── assertBatchSizesSane ───────────────────────────────────────────────────

test('assertBatchSizesSane accepts servings=1', () => {
  // Plan 024 explicitly allows 1-serving batches as a last resort.
  const store = buildPlanningStore();
  store.batches[0]!.servings = 1;
  assert.doesNotThrow(() => assertBatchSizesSane(buildCtx(store)));
});

test('assertBatchSizesSane accepts servings=3', () => {
  const store = buildPlanningStore();
  store.batches[0]!.servings = 3;
  assert.doesNotThrow(() => assertBatchSizesSane(buildCtx(store)));
});

test('assertBatchSizesSane flags servings=0', () => {
  const store = buildPlanningStore();
  store.batches[0]!.servings = 0;
  assert.throws(() => assertBatchSizesSane(buildCtx(store)), /servings outside \[1, 3\]/);
});

test('assertBatchSizesSane flags servings=4', () => {
  const store = buildPlanningStore();
  store.batches[0]!.servings = 4;
  assert.throws(() => assertBatchSizesSane(buildCtx(store)), /servings outside \[1, 3\]/);
});

// ─── assertCookDayFirstEating ───────────────────────────────────────────────

test('assertCookDayFirstEating passes on sorted eatingDays', () => {
  assert.doesNotThrow(() => assertCookDayFirstEating(buildCtx(buildPlanningStore())));
});

test('assertCookDayFirstEating flags unsorted eatingDays', () => {
  const store = buildPlanningStore();
  store.batches[0]!.eatingDays = ['2026-04-08', '2026-04-06']; // out of order
  assert.throws(
    () => assertCookDayFirstEating(buildCtx(store)),
    /not the earliest day/,
  );
});

// ─── assertWeeklyTotalsAbsorbed ─────────────────────────────────────────────

test('assertWeeklyTotalsAbsorbed passes on clean transcript', () => {
  assert.doesNotThrow(() =>
    assertWeeklyTotalsAbsorbed(
      buildCtx(buildPlanningStore(), [{ text: 'Your plan is ready.' }]),
    ),
  );
});

test('assertWeeklyTotalsAbsorbed flags ⚠️ off-target warning', () => {
  assert.throws(
    () =>
      assertWeeklyTotalsAbsorbed(
        buildCtx(buildPlanningStore(), [
          { text: 'Plan confirmed.\n\n⚠️ Macros are slightly off target after correction — review the numbers above.' },
        ]),
      ),
    /off target/,
  );
});

test('assertWeeklyTotalsAbsorbed ignores ⚠️ without target-deviation wording', () => {
  // Not every ⚠️ is a deviation warning (e.g. gap resolution prompts). Only
  // the ones whose text names deviation should trip the check.
  assert.doesNotThrow(() =>
    assertWeeklyTotalsAbsorbed(
      buildCtx(buildPlanningStore(), [{ text: '⚠️ Some recipes were edited.' }]),
    ),
  );
});

// ─── assertPlanningHealthy (composition) ────────────────────────────────────

test('assertPlanningHealthy passes on a healthy plan', () => {
  assert.doesNotThrow(() => assertPlanningHealthy(buildCtx(buildPlanningStore())));
});

test('assertPlanningHealthy aggregates multiple failures into one thrown error', () => {
  const store = buildPlanningStore();
  // Break two different primitives: ghost batch AND oversize servings.
  store.batches[0]!.actualPerServing = { calories: 0 };
  store.batches[1]!.servings = 4;
  let err: unknown;
  try {
    assertPlanningHealthy(buildCtx(store));
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, 'expected assertPlanningHealthy to throw');
  assert.match(err.message, /assertPlanningHealthy failed/);
  assert.match(err.message, /ghost batch/);
  assert.match(err.message, /servings outside \[1, 3\]/);
});
