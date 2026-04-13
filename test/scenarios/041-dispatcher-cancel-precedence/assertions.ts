/**
 * Scenario-local assertions for 041-dispatcher-cancel-precedence.
 *
 * Plan 032 Wave G — cancel phrase short-circuits the dispatcher. The
 * cancel-turn produces NO dispatcher action; the flow exits cleanly.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A cancel phrase ("nevermind"/"stop") during an open flow short-circuits ' +
  'the dispatcher entirely — no dispatcher action fires for the cancel turn, ' +
  'the flow exits cleanly (planFlow=null), and the user lands on the main menu.';

interface SessionShape {
  planFlow?: unknown;
  recipeFlow?: unknown;
  progressFlow?: unknown;
}

export function assertBehavior(ctx: AssertionsContext): void {
  // Zero dispatcher actions (the short-circuit consumed the only routing-
  // eligible turn before reaching the dispatcher).
  if (ctx.execTrace.dispatcherActions.length > 0) {
    throw new Error(
      `Expected zero dispatcher actions; got: ${ctx.execTrace.dispatcherActions.map((a) => a.action).join(', ')}.`,
    );
  }

  // All flows cleared.
  const session = ctx.finalSession as SessionShape | null | undefined;
  if (session?.planFlow !== null && session?.planFlow !== undefined) {
    throw new Error('Expected planFlow=null after cancel.');
  }
  if (session?.recipeFlow !== null && session?.recipeFlow !== undefined) {
    throw new Error('Expected recipeFlow=null after cancel.');
  }
}
