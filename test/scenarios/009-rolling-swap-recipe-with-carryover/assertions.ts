/**
 * Scenario-local assertions for 009-rolling-swap-recipe-with-carryover.
 *
 * Plan 032 Wave B/C — recipe swap via re-proposer on a non-pre-committed
 * batch. Carry-over slots from prior session stay intact while the new
 * batches rearrange.
 */

import {
  assertPlanningHealthy,
  assertRollingCarryOver,
  assertNoBatchOverlapsPriorSession,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'In a rolling continuation, a recipe-swap mutation routes through ' +
  'mutate_plan; the re-proposer rearranges batches without touching the ' +
  'pre-committed carry-over slots; mutationHistory grows by 1.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertRollingCarryOver(ctx);
  assertNoBatchOverlapsPriorSession(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);
  assertMutationHistoryLength(ctx, 1);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
