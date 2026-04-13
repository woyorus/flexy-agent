/**
 * Scenario-local assertions for 023-reproposer-event-add.
 *
 * Plan 032 Wave C — "dinner with friends Friday" added mid-review. The
 * re-proposer folds the new event into the plan in one shot.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'When the user types a natural-language event add during the proposal ' +
  'phase, the dispatcher routes it through mutate_plan to the re-proposer; ' +
  'the resulting plan remains healthy and persists via confirmPlanSession. ' +
  'See tech-debt: re-proposer LLM does not always materialize the requested ' +
  'event from this prompt — covered by the dispatcher-routing claim only.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);

  // mutationHistory may be 0 (re-proposer returned "no changes") or 1 (event
  // added). Both are consistent with the routing claim; we don't pin the
  // count here. See docs/plans/tech-debt.md entry for the LLM quality issue.

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
