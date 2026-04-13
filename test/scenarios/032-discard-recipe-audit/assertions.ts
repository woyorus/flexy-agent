/**
 * Scenario-local assertions for 032-discard-recipe-audit.
 *
 * Plan 032 Wave E — Plan 027 audit site #4 lock. Tapping Discard in the
 * recipe-creation flow clears recipeFlow. No plan state disturbed.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 027 audit lock (site #4): tapping Discard during recipe creation ' +
  'clears recipeFlow, leaves planFlow untouched (null), and the discard ' +
  'callback fires cleanly.';

interface SessionShape {
  planFlow?: unknown;
  recipeFlow?: unknown;
}

export function assertBehavior(ctx: AssertionsContext): void {
  const session = ctx.finalSession as SessionShape | null | undefined;
  if (session?.recipeFlow !== null && session?.recipeFlow !== undefined) {
    throw new Error(
      `Expected recipeFlow=null after discard; got ${JSON.stringify(session?.recipeFlow)?.slice(0, 120)}.`,
    );
  }
  if (session?.planFlow !== null && session?.planFlow !== undefined) {
    throw new Error(
      `Expected planFlow to remain null; got ${JSON.stringify(session?.planFlow)?.slice(0, 120)}.`,
    );
  }
  if (!ctx.execTrace.handlers.includes('callback:discard_recipe')) {
    throw new Error('Expected callback:discard_recipe; not found.');
  }
}
