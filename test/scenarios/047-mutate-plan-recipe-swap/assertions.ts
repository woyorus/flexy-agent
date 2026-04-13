/**
 * Scenario-local assertions for 047-mutate-plan-recipe-swap.
 *
 * Plan 032 Wave H — post-confirmation recipe swap via mutate_plan +
 * mp_confirm → confirmPlanSessionReplacing.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A post-confirmation recipe swap via free text routes through mutate_plan; ' +
  'mp_confirm persists the new plan via confirmPlanSessionReplacing.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan']);

  const replacing = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSessionReplacing',
  );
  if (!replacing) {
    throw new Error('Expected confirmPlanSessionReplacing; got none.');
  }
}
