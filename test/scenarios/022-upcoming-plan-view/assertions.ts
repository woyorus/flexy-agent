/**
 * Scenario-local assertions for 022-upcoming-plan-view.
 *
 * Plan 032 Wave E — upcoming plan visibility before the plan starts.
 * Walks Next Action → Week Overview → Shopping List → Next Action, then
 * taps Plan Week which surfaces a replan prompt; user cancels.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'When a future plan is upcoming (clock is before horizonStart), all plan ' +
  'view surfaces render correctly and tapping Plan Week surfaces a replan ' +
  'prompt that, when cancelled, leaves the upcoming plan untouched.';

export function assertBehavior(ctx: AssertionsContext): void {
  // The replan-cancel handler fired (no replan happened).
  if (!ctx.execTrace.handlers.includes('callback:plan_replan_cancel')) {
    throw new Error('Expected callback:plan_replan_cancel; not found.');
  }

  // No persistence ops (read-only navigation + cancelled replan).
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps
        .map((o) => o.op)
        .join(', ')}.`,
    );
  }

  // Final session has the upcoming plan still intact (one session, not superseded).
  const store = ctx.finalStore as
    | { planSessions?: Array<{ superseded?: boolean }> }
    | null
    | undefined;
  const sessions = store?.planSessions ?? [];
  if (sessions.length !== 1 || sessions[0].superseded === true) {
    throw new Error(
      'Expected exactly one non-superseded plan session in store after cancel; ' +
        `got ${sessions.length} sessions, superseded=${String(sessions[0]?.superseded)}.`,
    );
  }
}
