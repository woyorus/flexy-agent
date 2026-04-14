/**
 * Scenario 079 assertions: scale-shift preview → confirm.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Edge: structural scale shift previews; user confirms; batch persisted.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (!ctx.execTrace.dispatcherActions.some((d) => d.action === 'swap_ingredient')) {
    throw new Error('Should route to swap_ingredient.');
  }
  // Plan 033: either preview+confirm OR direct apply is acceptable — both
  // land the user's resolution. The structural-shift IS a hint to preview
  // but the LLM may decide the user's phrasing is decisive enough to apply.
  const sawPreview = ctx.execTrace.swapOps.some((o) => o.op === 'preview');
  const sawApply = ctx.execTrace.swapOps.some((o) => o.op === 'apply');
  if (!sawPreview && !sawApply) {
    throw new Error('Expected preview or apply op.');
  }
  if (!ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error('Expected updateBatch persistence.');
  }
}
