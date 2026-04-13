/**
 * Scenario-local assertions for 057-show-recipe-in-plan.
 *
 * Plan 032 Wave I — show_recipe renders cook view when the slug is in
 * the active batch set.
 */

import {
  assertDispatcherActions,
  assertLastRenderedView,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'show_recipe on a slug present in the active plan\'s batches renders ' +
  'the cook view for the soonest-eating batch; lastRenderedView reflects ' +
  'cooking/cook_view.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['show_recipe']);

  const session = ctx.finalSession as
    | { lastRenderedView?: { surface?: string; view?: string } }
    | null
    | undefined;
  const view = session?.lastRenderedView;
  if (view?.surface !== 'cooking' || view?.view !== 'cook_view') {
    throw new Error(
      `Expected lastRenderedView cooking/cook_view; got ${JSON.stringify(view)}.`,
    );
  }
}
