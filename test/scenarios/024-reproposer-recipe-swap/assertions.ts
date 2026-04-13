/**
 * Scenario-local assertions for 024-reproposer-recipe-swap.
 *
 * Plan 032 Wave C — "salmon instead of beef" → re-proposer picks a
 * salmon replacement and rebuilds the plan.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'When the user asks to swap a recipe via free text during the proposal ' +
  'phase, the dispatcher picks mutate_plan, the re-proposer picks a ' +
  'replacement recipe, and mutationHistory grows to 1.';

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
