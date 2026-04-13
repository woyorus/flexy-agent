/**
 * Scenario-local assertions for 063-show-progress-weekly-report.
 *
 * Plan 032 Wave I — show_progress with view=weekly_report renders the
 * completed-week summary.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'show_progress({ view: "weekly_report" }) routes through the dispatcher ' +
  'and renders the weekly report; no persistence.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['show_progress']);

  const params = ctx.execTrace.dispatcherActions[0]?.params as
    | { view?: string }
    | undefined;
  if (params?.view !== 'weekly_report') {
    throw new Error(
      `Expected show_progress params.view='weekly_report'; got ${String(params?.view)}.`,
    );
  }
}
