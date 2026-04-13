/**
 * Scenario-local assertions for 060-show-plan-day-detail-natural-language.
 *
 * Plan 032 Wave I — show_plan resolves a natural-language day ("Thursday")
 * to the next matching ISO date in the active horizon.
 */

import {
  assertDispatcherActions,
  assertLastRenderedView,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'show_plan on a natural-language day reference renders the day_detail ' +
  'view for the next matching ISO date; lastRenderedView reflects ' +
  'plan/day_detail with the resolved date.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['show_plan']);

  const session = ctx.finalSession as
    | { lastRenderedView?: { surface?: string; view?: string; day?: string } }
    | null
    | undefined;
  const view = session?.lastRenderedView;
  if (view?.surface !== 'plan' || view?.view !== 'day_detail') {
    throw new Error(
      `Expected lastRenderedView plan/day_detail; got ${JSON.stringify(view)}.`,
    );
  }
  if (typeof view.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(view.day)) {
    throw new Error(
      `Expected lastRenderedView.day to be ISO yyyy-mm-dd; got ${String(view.day)}.`,
    );
  }
}
