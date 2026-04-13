/**
 * Scenario-local assertions for 044-mutate-plan-in-session.
 *
 * Plan 032 Wave H — in-session mutation via mutate_plan dispatcher action.
 * The applier's in-session branch delegates to handleMutationText (same
 * code path as Wave C), so the outcome is identical to a re-proposer flow.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'An in-session mutation via mutate_plan routes through the in-session ' +
  'applier (delegates to the re-proposer), mutationHistory grows by 1, ' +
  'and the plan persists via confirmPlanSession (first confirmation).';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);
  assertMutationHistoryLength(ctx, 1);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) throw new Error('Expected confirmPlanSession.');
}
