/**
 * Scenario-local assertions for 033-recipe-edit-clears-planflow-audit.
 *
 * Plan 032 Wave E — Plan 027 audit site #5 lock. Tapping "Edit this recipe"
 * (re_<slug>) with a planFlow alive clears planFlow and enters recipe
 * edit mode. "Leave alone" audit decision — defensive clear preserved.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 027 audit lock (site #5): tapping re_<slug> with a planFlow alive ' +
  'clears planFlow (defensive) and enters the recipe edit flow. Locks the ' +
  'current behavior so a future dispatcher-driven change produces a visible diff.';

interface SessionShape {
  planFlow?: unknown;
  recipeFlow?: unknown;
}

export function assertBehavior(ctx: AssertionsContext): void {
  const session = ctx.finalSession as SessionShape | null | undefined;
  if (session?.planFlow !== null && session?.planFlow !== undefined) {
    throw new Error(
      `Expected planFlow=null after re_ tap; got ${JSON.stringify(session?.planFlow)?.slice(0, 120)}.`,
    );
  }
  // recipeFlow should be set (the edit UX entered).
  if (!session?.recipeFlow) {
    throw new Error('Expected recipeFlow to be set after re_ tap; got null/undefined.');
  }
  // The re_ callback fired.
  const fired = ctx.execTrace.handlers.some((h) =>
    h.startsWith('callback:re_'),
  );
  if (!fired) {
    throw new Error('Expected a callback:re_<slug> handler in trace; not found.');
  }
}
