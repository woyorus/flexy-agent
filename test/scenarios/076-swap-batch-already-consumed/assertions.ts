/**
 * Scenario 076 assertions: past batch rejects swap.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Edge: past batch swap returns hard_no; batch unchanged; pendingSwap absent.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error('Message should route to swap_ingredient.');
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'hard_no')) {
    throw new Error('Expected swap op=hard_no for a past batch.');
  }
  if (ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch' || p.op === 'updatePlanSessionBreakfast')) {
    throw new Error('Past-batch hard_no must not persist anything.');
  }
  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap) {
    throw new Error('pendingSwap should stay undefined.');
  }
  const finalStore = ctx.finalStore as { batches?: Array<{ scaledIngredients?: Array<{ name: string }>; swapHistory?: unknown[] }> };
  const b = finalStore.batches?.[0];
  if (!b) throw new Error('Batch missing.');
  const names = (b.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (!names.some((n) => n.includes('white wine'))) {
    throw new Error('White wine should still be present — the swap must have been rejected.');
  }
  if (b.swapHistory && b.swapHistory.length > 0) {
    throw new Error('swapHistory should remain empty.');
  }
}
