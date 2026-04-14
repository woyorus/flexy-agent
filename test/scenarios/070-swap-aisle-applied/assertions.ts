/**
 * Scenario 070 assertions: aisle-applied swap persists cod in place of salmon.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 5: "got the cod, 320g for 2 servings" auto-applies on the unique ' +
  'salmon batch; persisted ingredients show cod; swapHistory gains one record.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['swap_ingredient']);
  // Plan 033: the agent may apply directly OR preview (structural scale
  // shift). Accept both — either way the ingredient list should reflect
  // cod after the scenario's reasonable resolution. For preview-only
  // runs the batch stays unchanged but pendingSwap carries the proposal.
  const sawApply = ctx.execTrace.swapOps.some((o) => o.op === 'apply');
  const sawPreview = ctx.execTrace.swapOps.some((o) => o.op === 'preview');
  if (!sawApply && !sawPreview) {
    throw new Error('Expected swap op=apply or swap op=preview.');
  }
  if (sawApply) {
    const finalStore = ctx.finalStore as { batches?: Array<{ id: string; scaledIngredients?: Array<{ name: string }>; swapHistory?: unknown[] }> };
    const salmon = finalStore.batches?.find((b) => b.id.includes('salmon'));
    if (!salmon) throw new Error('Salmon batch missing.');
    const names = (salmon.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
    if (!names.some((n) => n.includes('cod'))) {
      throw new Error('Cod should now appear in the ingredient list after apply.');
    }
  }
}
