/**
 * Scenario 081 assertions: /start clears pendingSwap.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033: pendingSwap must be cleared by /start (lifecycle hook invariant).';

export function assertBehavior(ctx: AssertionsContext): void {
  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap !== undefined) {
    throw new Error('pendingSwap should be undefined after /start.');
  }
}
