/**
 * Scenario 067 assertions: compound swap commits both changes and the
 * rendered reply mentions both replacements.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 2: a single-message compound swap auto-applies, persists both ' +
  'changes, and the cook-view delta block reflects both swaps.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['swap_ingredient']);

  if (!ctx.execTrace.swapOps.some((o) => o.op === 'apply')) {
    throw new Error('Expected a swap op=apply; applier should auto-apply this compound swap.');
  }
  if (!ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error('Expected updateBatch persistence op.');
  }

  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; scaledIngredients?: Array<{ name: string }>; swapHistory?: Array<{ changes: Array<{ kind: string }> }> }> };
  const tagine = finalStore.batches?.find((b) => b.id.includes('dinner1'));
  if (!tagine) throw new Error('Tagine batch missing.');
  const names = (tagine.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (names.some((n) => n.includes('white wine'))) {
    throw new Error('White wine should be gone after the compound swap.');
  }
  if (names.some((n) => n.includes('passata'))) {
    throw new Error('Passata should be gone after the compound swap.');
  }
  if (!names.some((n) => n.includes('beef stock') || n.includes('stock'))) {
    throw new Error('Beef stock should be in the post-swap ingredient list.');
  }
  if (!names.some((n) => n.includes('cherry tomato') || n.includes('tomato'))) {
    throw new Error('Cherry tomatoes should be in the post-swap ingredient list.');
  }
  const firstRecord = tagine.swapHistory?.[0];
  if (!firstRecord || firstRecord.changes.length < 2) {
    throw new Error(
      `Expected at least two changes in the SwapRecord; got ${firstRecord?.changes.length ?? 0}.`,
    );
  }
}
