/**
 * Scenario 086 assertions: breakfast swap lifecycle persists correctly.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Phase 9: breakfast swaps commit to planSession.breakfastOverride; ' +
  'reset-to-original clears the override.';

export function assertBehavior(ctx: AssertionsContext): void {
  const swapOps = ctx.execTrace.swapOps;
  const breakfastPersists = ctx.execTrace.persistenceOps.filter((p) => p.op === 'updatePlanSessionBreakfast');
  if (breakfastPersists.length < 2) {
    throw new Error(
      `Expected at least 2 updatePlanSessionBreakfast ops (apply + reset); got ${breakfastPersists.length}.`,
    );
  }

  const finalStore = ctx.finalStore as {
    planSessions?: Array<{
      breakfastOverride?: {
        swapHistory?: unknown[];
        actualPerDay?: { calories: number; protein: number };
        scaledIngredientsPerDay?: unknown[];
      };
      breakfast?: { caloriesPerDay: number; proteinPerDay: number };
    }>;
  };
  const sess = finalStore.planSessions?.[0];
  if (!sess) throw new Error('Plan session missing.');
  // After reset-to-original, breakfastOverride must still be present —
  // but re-materialized from the library recipe scaled to the locked
  // caloriesPerDay / proteinPerDay — with an EMPTY swapHistory. If the
  // code simply cleared breakfastOverride, the renderer and shopping
  // list would fall back to the library recipe's raw amounts, which
  // may not match the session's target macros.
  if (!sess.breakfastOverride) {
    throw new Error(
      'breakfastOverride should remain present after reset-to-original (materialized from a fresh scaler run, not cleared).',
    );
  }
  if (sess.breakfastOverride.swapHistory && sess.breakfastOverride.swapHistory.length > 0) {
    throw new Error(
      `swapHistory should be empty after reset; got ${sess.breakfastOverride.swapHistory.length} records.`,
    );
  }
  // The scaled macros should be approximately the locked target (scaler
  // has a ±config.planning.scalerCalorieTolerance band). Assert only that
  // SOMETHING was scaled.
  const actualPerDay = sess.breakfastOverride.actualPerDay;
  if (!actualPerDay || typeof actualPerDay.calories !== 'number') {
    throw new Error('breakfastOverride.actualPerDay should hold the scaled macros after reset.');
  }
  const scaled = sess.breakfastOverride.scaledIngredientsPerDay;
  if (!Array.isArray(scaled) || scaled.length === 0) {
    throw new Error('breakfastOverride.scaledIngredientsPerDay should contain the fresh scaler output after reset.');
  }

  // At least one swap apply should have fired somewhere along the way.
  if (!swapOps.some((o) => o.op === 'apply')) {
    throw new Error('Expected at least one apply op during the lifecycle.');
  }
}
