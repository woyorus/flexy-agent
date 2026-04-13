/**
 * Scenario-local assertions for 053-mutate-plan-post-confirm-clarification-resume.
 *
 * Plan 032 Wave H — invariant #5 harness lock: ambiguous post-confirmation
 * mutation → clarification → auto-resume → forward-shift → confirm.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Invariant #5 harness lock: an ambiguous post-confirmation mutation ' +
  'triggers a clarification; the user\'s follow-up auto-resumes the flow ' +
  'and routes through mutate_plan again; mp_confirm persists via ' +
  'confirmPlanSessionReplacing. Two dispatcher turns, one final persist.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan', 'mutate_plan']);

  if (!ctx.execTrace.handlers.includes('callback:mp_confirm')) {
    throw new Error('Expected callback:mp_confirm; not found.');
  }

  const replacing = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSessionReplacing',
  );
  if (!replacing) {
    throw new Error('Expected confirmPlanSessionReplacing; got none.');
  }
}
