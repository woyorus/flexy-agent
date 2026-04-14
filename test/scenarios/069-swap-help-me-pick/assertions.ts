/**
 * Scenario 069 assertions: help-me-pick returns options WITHOUT touching
 * the batch or stashing pendingSwap.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 4: help-me-pick mode surfaces 2–3 options, does not persist, ' +
  'does not stash pendingSwap.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['swap_ingredient']);

  if (!ctx.execTrace.swapOps.some((o) => o.op === 'help_me_pick')) {
    throw new Error(
      `Expected swap op=help_me_pick; got: ${ctx.execTrace.swapOps.map((o) => o.op).join(', ')}`,
    );
  }
  if (ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch' || p.op === 'updatePlanSessionBreakfast')) {
    throw new Error('help-me-pick must not persist anything.');
  }

  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap) {
    throw new Error('help-me-pick must not stash pendingSwap.');
  }

  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; swapHistory?: unknown[] }> };
  const salmonBatch = finalStore.batches?.find((b) => b.id.includes('salmon'));
  if (salmonBatch?.swapHistory && salmonBatch.swapHistory.length > 0) {
    throw new Error('Salmon batch should have empty swapHistory after help-me-pick.');
  }
}
