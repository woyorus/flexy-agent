/**
 * Scenario 085 assertions: applier rejects an unrequested new
 * precisely-bought ingredient.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 guardrail: applier hard_nos when the LLM tries to introduce a new ' +
  'precisely-bought ingredient the user did not name.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'hard_no')) {
    throw new Error('Expected guardrail hard_no.');
  }
  if (ctx.execTrace.persistenceOps.some((p) => p.op === 'updateBatch')) {
    throw new Error('Guardrail rejection must not persist.');
  }
  const finalStore = ctx.finalStore as { batches?: Array<{ id: string; scaledIngredients?: Array<{ name: string }> }> };
  const tagine = finalStore.batches?.find((b) => b.id.includes('dinner1'));
  if (!tagine) throw new Error('Tagine batch missing.');
  const names = (tagine.scaledIngredients ?? []).map((i) => i.name.toLowerCase());
  if (names.some((n) => n.includes('pine nut'))) {
    throw new Error('Pine nuts must not land in the persisted batch.');
  }
}
