/**
 * Scenario 074 assertions: reset clears overrides + history; scaler ran.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Reversal §3: reset-to-original clears name/body overrides and swap history, ' +
  'persists a fresh scaler output.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error('Reset should route to swap_ingredient.');
  }
  if (!ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error('Expected updateBatch persistence for the reset.');
  }
  const finalStore = ctx.finalStore as { batches?: Array<{ nameOverride?: string; bodyOverride?: string; swapHistory?: unknown[] }> };
  const b = finalStore.batches?.[0];
  if (!b) throw new Error('Batch missing.');
  if (b.nameOverride) throw new Error('nameOverride should be cleared.');
  if (b.bodyOverride) throw new Error('bodyOverride should be cleared.');
  if (b.swapHistory && b.swapHistory.length > 0) {
    throw new Error('swapHistory should be empty after reset.');
  }
}
