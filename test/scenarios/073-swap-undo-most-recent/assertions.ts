/**
 * Scenario 073 assertions: "undo" reverses the most recent swap only.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Reversal §1: "undo" reverses only the most-recent SwapRecord; earlier records stay. ' +
  'Final batch ingredients reflect the pre-most-recent state.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error('Undo should route to swap_ingredient.');
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'apply')) {
    throw new Error('Expected swap op=apply for the reversal.');
  }
  const finalStore = ctx.finalStore as { batches?: Array<{ scaledIngredients?: Array<{ name: string }>; swapHistory?: Array<{ userMessage: string }> }> };
  const b = finalStore.batches?.[0];
  if (!b) throw new Error('Batch missing.');
  const names = (b.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  // Passata should be back; cherry tomatoes should be gone.
  if (!names.some((n) => n.includes('passata'))) {
    throw new Error('Passata should be restored after the undo.');
  }
  if (names.some((n) => n.includes('cherry tomato'))) {
    throw new Error('Cherry tomatoes should be gone after the undo.');
  }
  // Wine→stock swap is still in effect: beef stock stays.
  if (!names.some((n) => n.includes('stock'))) {
    throw new Error('Beef stock should still be present — only the most-recent swap was undone.');
  }
}
