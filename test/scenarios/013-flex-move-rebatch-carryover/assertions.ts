/**
 * Scenario-local assertions for 013-flex-move-rebatch-carryover.
 *
 * Plan 032 Wave B/C — flex-move mutation that triggers re-batching. Despite
 * the name, the spec runs from an empty initial state (no actual prior-
 * session carry-over) — the "rebatch" refers to in-session batch
 * rearrangement so a moved flex slot doesn't strand any meals.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A free-text flex-move request during the proposal phase routes through ' +
  'mutate_plan, the re-proposer rebatches the plan to satisfy the request ' +
  'without orphaning any slots, mutationHistory grows by 1, and the result ' +
  'persists.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);
  assertMutationHistoryLength(ctx, 1);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
