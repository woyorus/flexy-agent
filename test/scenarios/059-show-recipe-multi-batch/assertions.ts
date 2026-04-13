/**
 * Scenario-local assertions for 059-show-recipe-multi-batch.
 *
 * Plan 032 Wave I — show_recipe on a slug that appears in multiple
 * batches picks the soonest cook day.
 */

import {
  assertDispatcherActions,
  assertLastRenderedView,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'show_recipe on a slug present in multiple active batches renders the ' +
  'cook view for the batch with the soonest cook day (not the most recent, ' +
  'not the farthest).';

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
