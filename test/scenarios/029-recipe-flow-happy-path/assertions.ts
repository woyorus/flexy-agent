/**
 * Scenario-local assertions for 029-recipe-flow-happy-path.
 *
 * Plan 032 Wave F — standalone recipe-creation flow end-to-end: list →
 * add → meal type → preferences → save. Recipe persists to the sandboxed
 * RecipeDatabase; recipeFlow clears on save.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'The standalone recipe flow (My Recipes → Add → meal type → preferences ' +
  '→ Save) runs the generator, persists the new recipe, and clears ' +
  'recipeFlow on save. Dispatcher routes the preferences free text through ' +
  'flow_input.';

interface SessionShape {
  recipeFlow?: unknown;
}

export function assertBehavior(ctx: AssertionsContext): void {
  const session = ctx.finalSession as SessionShape | null | undefined;
  if (session?.recipeFlow !== null && session?.recipeFlow !== undefined) {
    throw new Error(
      `Expected recipeFlow=null after save; got ${JSON.stringify(session?.recipeFlow)?.slice(0, 120)}.`,
    );
  }
  if (!ctx.execTrace.handlers.includes('callback:save_recipe')) {
    throw new Error('Expected callback:save_recipe; not found.');
  }
  // Dispatcher sees the free-text preferences as flow_input.
  const flowInput = ctx.execTrace.dispatcherActions.find(
    (a) => a.action === 'flow_input',
  );
  if (!flowInput) {
    throw new Error(
      'Expected a flow_input dispatcher action; got: ' +
        ctx.execTrace.dispatcherActions.map((a) => a.action).join(', '),
    );
  }
}
