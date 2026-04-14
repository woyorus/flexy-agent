/**
 * Scenario 068 assertions: both removals land in the persisted batch and
 * both are acknowledged in the reply.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 Screen 3: two removals named in one message — the resulting batch has ' +
  'neither ingredient, and the acknowledgment rule surfaces both in the delta block.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['swap_ingredient']);

  if (!ctx.execTrace.swapOps.some((o) => o.op === 'apply')) {
    throw new Error('Expected swap op=apply.');
  }

  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; scaledIngredients?: Array<{ name: string }> }> };
  const tagine = finalStore.batches?.find((b) => b.id.includes('dinner1'));
  if (!tagine) throw new Error('Tagine batch missing.');
  const names = (tagine.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (names.some((n) => n.includes('raisin'))) {
    throw new Error('Raisins should be removed.');
  }
  if (names.some((n) => n.includes('parsley'))) {
    throw new Error('Parsley should be removed.');
  }

  const reply = ctx.outputs[ctx.outputs.length - 1]?.text ?? '';
  if (!/raisin/i.test(reply)) {
    throw new Error('Reply should mention raisins (acknowledgment rule).');
  }
  if (!/parsley/i.test(reply)) {
    throw new Error('Reply should mention parsley (acknowledgment rule).');
  }
}
