/**
 * Scenario-local assertions for 026-reproposer-multi-mutation.
 *
 * Plan 032 Wave C — two sequential mutations on the same proposal. Each
 * routes through mutate_plan; each adds an entry to mutation history.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Two sequential free-text mutations during the proposal phase each route ' +
  'through mutate_plan; both land on the re-proposer; mutationHistory grows ' +
  'to 2 and the second mutation does not clobber the first.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan', 'mutate_plan']);
  assertMutationHistoryLength(ctx, 2);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
