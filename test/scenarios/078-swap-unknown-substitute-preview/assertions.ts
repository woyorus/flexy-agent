/**
 * Scenario 078 assertions: unknown-substitute preview + confirm.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Edge: unknown substitute previews, user confirms, commit happens via pre-filter.';

export function assertBehavior(ctx: AssertionsContext): void {
  // Strict: an ingredient swap on a named ingredient ("instead of
  // parsley, use my grandma's pickled wild garlic") is unambiguously a
  // swap_ingredient intent — the dispatcher must route it there. Routing
  // to clarify would mean a real user has to repeat themselves, which
  // is the exact JTBD friction the feature exists to remove.
  if (ctx.execTrace.dispatcherActions[0]?.action !== 'swap_ingredient') {
    throw new Error(
      `First dispatcher call should route to swap_ingredient (the user clearly named an ingredient swap); ` +
      `got ${ctx.execTrace.dispatcherActions[0]?.action}.`,
    );
  }
  const sawPreview = ctx.execTrace.swapOps.some((o) => o.op === 'preview');
  const sawApply = ctx.execTrace.swapOps.some((o) => o.op === 'apply');
  if (!sawPreview && !sawApply) {
    throw new Error('Expected swap op=preview or swap op=apply.');
  }
  if (!ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error('Expected updateBatch persistence — the swap should land either directly or via pre-filter confirm.');
  }
  const finalSession = ctx.finalSession as { pendingSwap?: unknown };
  if (finalSession.pendingSwap) {
    throw new Error('pendingSwap should be cleared by the end of the scenario.');
  }
}
