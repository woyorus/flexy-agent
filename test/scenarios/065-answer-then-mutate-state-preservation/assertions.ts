/**
 * Scenario-local assertions for 065-answer-then-mutate-state-preservation.
 *
 * Plan 032 Wave I — cross-action state preservation lock: during an open
 * planFlow, a clarify dispatcher call does not disturb planFlow; a
 * subsequent mutate_plan picks up where the proposal left off.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Cross-action state preservation: a clarify followed by mutate_plan ' +
  'during an open planFlow does not clobber planFlow — both dispatches ' +
  'land, the user approves a clean final plan, and persistence fires.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['clarify', 'mutate_plan']);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) throw new Error('Expected confirmPlanSession.');
}
