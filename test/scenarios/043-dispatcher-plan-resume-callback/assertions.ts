/**
 * Scenario-local assertions for 043-dispatcher-plan-resume-callback.
 *
 * Plan 032 Wave G — `plan_resume` inline callback re-renders the proposal
 * via handleReturnToFlowAction delegation WITHOUT routing through the
 * dispatcher. Regression lock for proposal 003 invariant #7.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Tapping the plan_resume inline back-button re-renders the stored ' +
  'proposalText via handleReturnToFlowAction without a dispatcher call; ' +
  'only the preceding free-text "weather?" fires the dispatcher ' +
  '(out_of_scope). The plan approves cleanly and persists.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);

  // Only the out_of_scope dispatch — the plan_resume callback bypasses it.
  assertDispatcherActions(ctx, ['out_of_scope']);

  // plan_resume callback fired.
  if (!ctx.execTrace.handlers.includes('callback:plan_resume')) {
    throw new Error('Expected callback:plan_resume in trace; not found.');
  }

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) throw new Error('Expected confirmPlanSession.');
}
