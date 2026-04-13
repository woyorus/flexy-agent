/**
 * Scenario-local assertions for 002-plan-week-flex-move-regression.
 *
 * Plan 032 Wave C — text-driven flex move during proposal phase. User types
 * "move flex to Wednesday"; dispatcher picks mutate_plan; the in-session
 * applier delegates to the re-proposer; the re-proposer rearranges the
 * plan and mutation history grows by one.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'When the user types a flex-move request during the proposal phase, the ' +
  'dispatcher picks mutate_plan, the re-proposer rearranges the plan to ' +
  'satisfy the request, mutationHistory grows by 1, and the final plan is ' +
  'healthy and persisted via confirmPlanSession.';

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
