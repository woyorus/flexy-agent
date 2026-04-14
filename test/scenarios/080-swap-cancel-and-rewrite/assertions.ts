/**
 * Scenario 080 assertions: rewrite/cancel state management.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 state preservation: rewrite message falls through to dispatcher; cancel pre-filter clears pendingSwap.';

export function assertBehavior(ctx: AssertionsContext): void {
  // First two messages route to swap_ingredient via the dispatcher (preview + rewrite).
  const swapDispatches = ctx.execTrace.dispatcherActions.filter((d) => d.action === 'swap_ingredient').length;
  if (swapDispatches < 2) {
    throw new Error(`Expected at least 2 swap_ingredient dispatches; got ${swapDispatches}.`);
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'prefilter_cancel')) {
    throw new Error('Expected prefilter_cancel on the "nevermind" turn.');
  }
  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap) throw new Error('pendingSwap should be cleared by cancel.');
}
