/**
 * Scenario 084 assertions: delta block mentions the helper even when
 * the agent forgot to emit it in delta_lines.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033 guardrail: the rendered delta block mentions "lemon juice" because the applier ' +
  'regenerated delta lines from `changes`, even though the agent omitted it from `delta_lines`.';

export function assertBehavior(ctx: AssertionsContext): void {
  if (!ctx.execTrace.swapOps.some((o) => o.op === 'apply')) {
    throw new Error('Expected swap op=apply (the swap should still succeed).');
  }
  const reply = ctx.outputs[ctx.outputs.length - 1]?.text ?? '';
  if (!/lemon juice/i.test(reply)) {
    throw new Error('Rendered delta block should mention lemon juice (applier-regenerated line).');
  }
}
