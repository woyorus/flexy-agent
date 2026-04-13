/**
 * Scenario-local assertions for 040-dispatcher-clarify-multiturn.
 *
 * Plan 032 Wave G — clarify action with a follow-up turn; recentTurns
 * carries the clarification across dispatches.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A vague request routes to clarify; the follow-up (still ambiguous) also ' +
  'routes to clarify; no persistence, no flow entered — the clarification ' +
  'round-trip is faithful to the user\'s input.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['clarify', 'clarify']);
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps.map((o) => o.op).join(', ')}.`,
    );
  }
}
