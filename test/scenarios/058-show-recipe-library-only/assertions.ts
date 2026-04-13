/**
 * Scenario-local assertions for 058-show-recipe-library-only.
 *
 * Plan 032 Wave I — show_recipe falls back to library view when the slug
 * is not in any active batch.
 */

import {
  assertDispatcherActions,
  assertLastRenderedView,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'show_recipe on a slug absent from the active plan falls back to the ' +
  'library recipe-detail view; lastRenderedView reflects recipes/recipe_detail.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['show_recipe']);

  const session = ctx.finalSession as
    | { lastRenderedView?: { surface?: string; view?: string } }
    | null
    | undefined;
  const view = session?.lastRenderedView;
  if (view?.surface !== 'recipes' || view?.view !== 'recipe_detail') {
    throw new Error(
      `Expected lastRenderedView recipes/recipe_detail; got ${JSON.stringify(view)}.`,
    );
  }
}
