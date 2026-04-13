/**
 * Scenario-local assertions for 038-dispatcher-out-of-scope.
 *
 * Plan 032 Wave G — out-of-domain request produces out_of_scope + menu
 * guidance, no flow mutation.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'An out-of-domain free-text request routes through the dispatcher to ' +
  'out_of_scope; the bot produces menu guidance without entering any flow ' +
  'or persisting state.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['out_of_scope']);
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps.map((o) => o.op).join(', ')}.`,
    );
  }
}
