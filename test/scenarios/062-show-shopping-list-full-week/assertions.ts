/**
 * Scenario-local assertions for 062-show-shopping-list-full-week.
 *
 * Plan 032 Wave F — "full shopping list for the week" routes through the
 * dispatcher's show_shopping_list action with `scope: 'full_week'`. The
 * renderer aggregates every batch + prorated breakfast.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Typing "full shopping list for the week" routes through the dispatcher ' +
  'to show_shopping_list with scope="full_week"; the rendered output covers ' +
  'every batch in the active plan plus prorated breakfast ingredients.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['show_shopping_list']);

  const params = ctx.execTrace.dispatcherActions[0]?.params as
    | { scope?: string }
    | undefined;
  if (params?.scope !== 'full_week') {
    throw new Error(
      `Expected dispatcher params.scope='full_week'; got ${String(params?.scope)}.`,
    );
  }
}
