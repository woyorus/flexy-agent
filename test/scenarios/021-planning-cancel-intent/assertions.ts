/**
 * Scenario-local assertions for 021-planning-cancel-intent.
 *
 * Plan 032 Wave I — "nevermind" during proposal short-circuits before
 * dispatcher; planFlow clears; no persistence.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A cancel meta-intent during an open planFlow short-circuits the ' +
  'dispatcher entirely (zero dispatcher actions for that turn), ' +
  'planFlow clears, surfaceContext clears, and no persistence runs.';

interface SessionShape {
  planFlow?: unknown;
  surfaceContext?: unknown;
}

export function assertBehavior(ctx: AssertionsContext): void {
  if (ctx.execTrace.dispatcherActions.length > 0) {
    throw new Error(
      `Expected zero dispatcher actions; got: ${ctx.execTrace.dispatcherActions.map((a) => a.action).join(', ')}.`,
    );
  }
  const session = ctx.finalSession as SessionShape | null | undefined;
  if (session?.planFlow !== null && session?.planFlow !== undefined) {
    throw new Error('Expected planFlow=null after cancel.');
  }
  if (session?.surfaceContext !== null && session?.surfaceContext !== undefined) {
    throw new Error(
      `Expected surfaceContext=null after cancel; got ${String(session?.surfaceContext)}.`,
    );
  }
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error('Expected zero persistence ops after cancel.');
  }
}
