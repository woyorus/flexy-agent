/**
 * Scenario-local assertions for 049-mutate-plan-adjust-loop.
 *
 * Plan 032 Wave H — tap [Adjust] → type new mutation → [Confirm]. Two
 * mutate_plan dispatches; only the second mutation persists (adjust-
 * overrides-pending semantics). The first is abandoned via mp_adjust.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'When the user taps mp_adjust to override a pending mutation and types a ' +
  'new one, the adjust loop re-runs mutate_plan; mp_confirm persists only ' +
  'the second (final) mutation via confirmPlanSessionReplacing.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan', 'mutate_plan']);

  if (!ctx.execTrace.handlers.includes('callback:mp_adjust')) {
    throw new Error('Expected callback:mp_adjust in handlers; not found.');
  }
  if (!ctx.execTrace.handlers.includes('callback:mp_confirm')) {
    throw new Error('Expected callback:mp_confirm in handlers; not found.');
  }

  const replacing = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSessionReplacing',
  );
  if (!replacing) {
    throw new Error('Expected confirmPlanSessionReplacing; got none.');
  }
}
