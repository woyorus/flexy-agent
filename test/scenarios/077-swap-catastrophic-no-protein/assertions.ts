/**
 * Scenario 077 assertions: catastrophic identity-break → hard_no.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Edge: removing every protein on a protein-identity dish returns hard_no; ' +
  'no persistence.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error('Message should route to swap_ingredient.');
  }
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'hard_no')) {
    throw new Error('Expected swap op=hard_no for the identity-break.');
  }
  if (ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch' || p.op === 'updatePlanSessionBreakfast')) {
    throw new Error('Identity-break must not persist.');
  }
  const finalStore = ctx.finalStore as { batches?: Array<{ scaledIngredients?: Array<{ name: string }> }> };
  const salmon = finalStore.batches?.find((b) => {
    const names = (b.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
    return names.some((n) => n.includes('salmon'));
  });
  if (!salmon) throw new Error('Salmon batch should still exist unchanged.');
}
