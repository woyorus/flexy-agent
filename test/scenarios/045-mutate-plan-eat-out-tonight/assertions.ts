/**
 * Scenario-local assertions for 045-mutate-plan-eat-out-tonight.
 *
 * Plan 032 Wave H — THE canonical Plan D Flow 1 scenario. Post-
 * confirmation mutation: user says "I'm eating out tonight" with an
 * active confirmed plan. Dispatcher picks mutate_plan; the post-
 * confirmation applier runs adapter + re-proposer + solver + diff;
 * user taps mp_confirm which persists via confirmPlanSessionReplacing.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan D Flow 1: with an active confirmed plan, "I\'m eating out tonight" ' +
  'routes through mutate_plan to the post-confirmation applier (adapter + ' +
  're-proposer + solver + diff); mp_confirm persists via ' +
  'confirmPlanSessionReplacing; the new plan is healthy.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);

  if (!ctx.execTrace.handlers.includes('callback:mp_confirm')) {
    throw new Error('Expected callback:mp_confirm handler; not found.');
  }

  const replacing = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSessionReplacing',
  );
  if (!replacing) {
    throw new Error(
      'Expected confirmPlanSessionReplacing; got: ' +
        ctx.execTrace.persistenceOps.map((o) => o.op).join(', '),
    );
  }
}
