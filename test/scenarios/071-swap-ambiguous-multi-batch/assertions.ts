/**
 * Scenario 071 assertions: multi-batch preview + "both" commit.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 6: chicken-in-two-batches preview, "both" pre-filter commits both; ' +
  'each batch now has tofu; pendingSwap cleared after commit.';

export function assertBehavior(ctx: AssertionsContext): void {
  // First turn routes through dispatcher → swap_ingredient → preview.
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error('First turn should route to swap_ingredient.');
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'preview')) {
    throw new Error('Expected a preview op on the first turn.');
  }
  // Second turn ("both") is handled by the pre-filter — dispatcher is NOT called.
  if (ctx.execTrace.dispatcherActions.length > 1) {
    throw new Error(
      `Pre-filter should have consumed "both" before the dispatcher; saw ${ctx.execTrace.dispatcherActions.length} dispatcher calls.`,
    );
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'prefilter_pick' && o.reason === 'both')) {
    throw new Error('Expected a prefilter_pick with reason=both.');
  }

  const finalStore = ctx.finalStore as { batches?: Array<{ scaledIngredients?: Array<{ name: string }>; swapHistory?: unknown[] }> };
  const bothBatches = finalStore.batches ?? [];
  if (bothBatches.length !== 2) {
    throw new Error(`Expected 2 batches in finalStore; got ${bothBatches.length}.`);
  }
  for (const b of bothBatches) {
    const names = (b.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
    if (names.some((n) => n.includes('chicken'))) {
      throw new Error('All batches should have chicken replaced with tofu.');
    }
    if (!names.some((n) => n.includes('tofu'))) {
      throw new Error('All batches should now contain tofu.');
    }
    if (!b.swapHistory || b.swapHistory.length !== 1) {
      throw new Error('Every committed batch should carry one SwapRecord.');
    }
  }

  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap) {
    throw new Error('pendingSwap should be cleared after the pre-filter commit.');
  }
}
