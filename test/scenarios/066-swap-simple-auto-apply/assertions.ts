/**
 * Scenario 066 assertions: the simple auto-apply path persists a swap and
 * renders a delta block.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 1: an unambiguous ingredient-level swap on a confirmed plan ' +
  'routes through swap_ingredient, auto-applies, persists a SwapRecord, and ' +
  'renders a delta block — no preview, no clarification.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['swap_ingredient']);

  if (!ctx.execTrace.swapOps.some((o) => o.op === 'apply')) {
    throw new Error(
      `Expected a swap op=apply; got: ${ctx.execTrace.swapOps.map((o) => o.op).join(', ')}`,
    );
  }

  if (!ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error(
      `Expected updateBatch persistence; got: ${ctx.execTrace.persistenceOps.map((p) => p.op).join(', ')}`,
    );
  }

  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; swapHistory?: unknown[]; scaledIngredients?: Array<{ name: string }> }> };
  const tagine = finalStore.batches?.find((b) => b.id.includes('dinner1'));
  if (!tagine) throw new Error('Tagine batch not in finalStore.');
  if (!tagine.swapHistory || tagine.swapHistory.length !== 1) {
    throw new Error(
      `Expected tagine.swapHistory length 1; got ${tagine.swapHistory?.length ?? 'absent'}`,
    );
  }
  const ingredientNames = (tagine.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (ingredientNames.some((n) => n.includes('white wine'))) {
    throw new Error('Tagine should no longer contain dry white wine after the swap.');
  }
}
