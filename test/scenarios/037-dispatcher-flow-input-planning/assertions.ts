/**
 * Scenario-local assertions for 037-dispatcher-flow-input-planning.
 *
 * Plan 032 Wave G — mutation text during the planning proposal phase
 * routes to mutate_plan, which invokes the re-proposer.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'During the planning proposal phase, free-text input routes through the ' +
  'dispatcher to mutate_plan and the re-proposer; the final plan is healthy ' +
  'and persists.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) throw new Error('Expected confirmPlanSession.');
}
