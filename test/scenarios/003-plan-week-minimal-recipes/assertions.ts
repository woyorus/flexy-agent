/**
 * Scenario-local assertions for 003-plan-week-minimal-recipes.
 *
 * Plan 032 Wave A — minimal recipe library (2 recipes) forces the
 * proposer to reuse the same recipes across multiple slots and triggers
 * the gap-resolution sub-flow. User skips gaps using existing recipes.
 */

import { assertPlanningHealthy } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'With a 2-recipe library, the proposer reuses recipes across slots to ' +
  'cover the whole week without gaps or ghost batches; the gap-resolution ' +
  'sub-flow surfaces missing-recipe choices which the user skips, and the ' +
  'plan persists via confirmPlanSession.';

interface BatchShape {
  recipeSlug?: string;
  mealType: 'lunch' | 'dinner';
  eatingDays: string[];
  status: 'planned' | 'cancelled';
}

export function assertBehavior(ctx: AssertionsContext): void {
  // 1. Plan is structurally healthy despite the minimal recipe set.
  assertPlanningHealthy(ctx);

  // 2. At least one batch spans multiple eating days (recipe reuse is the
  //    defining feature of a minimal library).
  const batches = ctx.batches() as readonly BatchShape[];
  const active = batches.filter((b) => b.status !== 'cancelled');
  const reused = active.find((b) => (b.eatingDays?.length ?? 0) >= 2);
  if (!reused) {
    throw new Error(
      'Expected at least one batch to span multiple eating days (recipe reuse); ' +
        `got ${active.length} batches, none spanning >= 2 days.`,
    );
  }

  // 3. Gap-resolution sub-flow fired — the spec's `plan_skip_gap_*` clicks
  //    only route if the proposer actually surfaced gaps.
  const skippedGaps = ctx.execTrace.handlers.filter((h) =>
    h.startsWith('callback:plan_skip_gap_'),
  );
  if (skippedGaps.length === 0) {
    throw new Error(
      'Expected at least one `plan_skip_gap_*` callback to fire; got none. ' +
        'The proposer may no longer be emitting gaps for the minimal library.',
    );
  }

  // 4. Persistence via confirmPlanSession.
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected a `confirmPlanSession` persistence op; got none.');
  }
}
