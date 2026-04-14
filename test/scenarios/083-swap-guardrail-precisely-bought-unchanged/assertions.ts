/**
 * Scenario 083 assertions: the applier rejects a silently-mutated
 * precisely-bought ingredient with hard_no.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 guardrail: injected LLM response shrinks ground beef without the user asking; ' +
  'applier returns hard_no. Seed ground beef stays 200g.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'hard_no')) {
    throw new Error(
      `Expected swap op=hard_no (guardrail rejection); got: ${ctx.execTrace.swapOps.map((o) => o.op).join(', ')}`,
    );
  }
  if (ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error('Guardrail rejection must not persist.');
  }
  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; scaledIngredients?: Array<{ name: string; amount: number }> }> };
  const tagine = finalStore.batches?.find((b) => b.id.includes('dinner1'));
  if (!tagine) throw new Error('Tagine batch missing.');
  const beef = tagine.scaledIngredients?.find((i) => i.name.toLowerCase().includes('beef'));
  if (!beef || beef.amount !== 200) {
    throw new Error(`Ground beef should stay 200g; got ${beef?.amount}.`);
  }
}
