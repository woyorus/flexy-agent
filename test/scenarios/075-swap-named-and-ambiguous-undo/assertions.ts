/**
 * Scenario 075 assertions: named reversal + follow-up undo sequence.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Reversal §2+§4: named reversal targets the specific swap; a subsequent ' +
  '"undo" reverses the remaining record.';

export function assertBehavior(ctx: AssertionsContext): void {
  const dispatcherCalls = ctx.execTrace.dispatcherActions;
  if (dispatcherCalls.length !== 2) {
    throw new Error(`Expected 2 dispatcher calls; got ${dispatcherCalls.length}.`);
  }
  if (dispatcherCalls.every((d) => d.action === 'swap_ingredient') === false) {
    throw new Error('Both turns should route to swap_ingredient.');
  }

  // After both turns, all swaps should be reversed — ingredient list should
  // reflect the library recipe baseline (no beef stock, no cherry tomatoes,
  // white wine and passata restored).
  const finalStore = ctx.finalStore as { batches?: Array<{ scaledIngredients?: Array<{ name: string }> }> };
  const b = finalStore.batches?.[0];
  if (!b) throw new Error('Batch missing.');
  const names = (b.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (names.some((n) => n.includes('beef stock'))) {
    throw new Error('Beef stock should be reversed back to wine after both undo turns.');
  }
  if (names.some((n) => n.includes('cherry tomato'))) {
    throw new Error('Cherry tomatoes should be reversed back to passata after named undo.');
  }
}
