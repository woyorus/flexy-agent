/**
 * Scenario-local assertions for 061-show-shopping-list-recipe-scope.
 *
 * Plan 032 Wave F — "shopping list for the tagine" routes through the
 * dispatcher's show_shopping_list action with `scope: 'recipe'`. The
 * renderer produces a scoped ingredient list.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Typing "shopping list for the tagine" routes through the dispatcher to ' +
  'show_shopping_list with scope="recipe" and the matching recipe_slug; ' +
  'the rendered output scopes to that recipe\'s ingredients only.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['show_shopping_list']);

  // The dispatcher params carry the recipe scope + slug.
  const action = ctx.execTrace.dispatcherActions[0];
  const params = action?.params as
    | { scope?: string; recipe_slug?: string }
    | undefined;
  if (params?.scope !== 'recipe') {
    throw new Error(
      `Expected dispatcher params.scope='recipe'; got ${String(params?.scope)}.`,
    );
  }
  if (typeof params?.recipe_slug !== 'string' || params.recipe_slug.length === 0) {
    throw new Error(
      `Expected dispatcher params.recipe_slug to be a non-empty string; got ${String(params?.recipe_slug)}.`,
    );
  }
}
