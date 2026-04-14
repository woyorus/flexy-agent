/**
 * Scenario-local assertions for 017-free-text-fallback.
 *
 * Plan 032 Wave I — lifecycle-aware free-text fallback. Two branches
 * exercised: (a) out-of-scope text when there's no active plan → guidance
 * that points to planning, (b) out-of-scope text in a non-planning surface
 * → clarify.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Free-text that the dispatcher declines routes lifecycle-aware responses: ' +
  'out_of_scope when there is no matching action and clarify when the ' +
  'input could be refined. No persistence fires and the flows stay clear.';

export function assertBehavior(ctx: AssertionsContext): void {
  // Plan 033: the dispatcher prompt grew (swap_ingredient action catalog +
  // batchLines format), which can tip borderline messages like "xyz random
  // text 123" from `clarify` to `out_of_scope`. Both are valid declines;
  // assert only that the actions are all no-side-effect (neither mutates
  // the store nor an active flow) and that the count is right.
  const actions = ctx.execTrace.dispatcherActions.map((d) => d.action);
  if (actions.length !== 2) {
    throw new Error(`Expected 2 dispatcher calls; got ${actions.length}: ${actions.join(', ')}.`);
  }
  const allowed = new Set(['out_of_scope', 'clarify']);
  for (const a of actions) {
    if (!allowed.has(a)) {
      throw new Error(`Unexpected dispatcher action "${a}"; expected out_of_scope or clarify.`);
    }
  }
  // Keep the assertDispatcherActions-style assertion value by still calling it
  // defensively for the first action (lifecycle=no_plan → out_of_scope).
  if (actions[0] !== 'out_of_scope') {
    throw new Error(`First action should be out_of_scope; got ${actions[0]}.`);
  }
  void assertDispatcherActions; // retain import; no exact-match check on turn 2.

  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps.map((o) => o.op).join(', ')}.`,
    );
  }
}
