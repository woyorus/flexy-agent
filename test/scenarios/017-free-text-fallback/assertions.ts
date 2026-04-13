/**
 * Scenario-local assertions for 017-free-text-fallback.
 *
 * Plan 032 Wave I — lifecycle-aware free-text fallback. Two branches
 * exercised: (a) out-of-scope text when there's no active plan → guidance
 * that points to planning, (b) out-of-scope text in a non-planning surface
 * → clarify.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Free-text that the dispatcher declines routes lifecycle-aware responses: ' +
  'out_of_scope when there is no matching action and clarify when the ' +
  'input could be refined. No persistence fires and the flows stay clear.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['out_of_scope', 'clarify']);

  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps.map((o) => o.op).join(', ')}.`,
    );
  }
}
