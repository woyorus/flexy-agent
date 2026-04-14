/**
 * Scenario 072 assertions: structural preview + pre-filter commit.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 7: structural swap previews first with reason=structural; "go ahead" ' +
  'pre-filter commits without a second dispatcher call; final batch has tofu.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error('First turn should route to swap_ingredient.');
  }
  const preview = ctx.execTrace.swapOps.find((o) => o.op === 'preview');
  if (!preview) throw new Error('Expected a preview op on the first turn.');
  if (preview.reason !== 'structural') {
    throw new Error(`Expected preview.reason=structural; got ${preview.reason}.`);
  }
  if (ctx.execTrace.dispatcherActions.length > 1) {
    throw new Error('Pre-filter should have consumed "go ahead" before the dispatcher.');
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'prefilter_confirm')) {
    throw new Error('Expected a prefilter_confirm op.');
  }

  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; scaledIngredients?: Array<{ name: string }>; swapHistory?: unknown[] }> };
  const lunchBowl = finalStore.batches?.find((b) => b.id.includes('lunch1'));
  if (!lunchBowl) throw new Error('Lunch-bowl batch missing.');
  const names = (lunchBowl.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (names.some((n) => n.includes('chicken'))) {
    throw new Error('Chicken should be replaced.');
  }
  if (!names.some((n) => n.includes('tofu'))) {
    throw new Error('Tofu should now appear.');
  }
  if (!lunchBowl.swapHistory || lunchBowl.swapHistory.length !== 1) {
    throw new Error('Lunch-bowl batch should have one SwapRecord.');
  }

  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap) {
    throw new Error('pendingSwap should be cleared after the pre-filter commit.');
  }
}
