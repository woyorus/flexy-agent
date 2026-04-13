/**
 * Scenario-local assertions for 036-day-detail-back-button-audit.
 *
 * Plan 032 Wave E — locks the current "← Back to week" behavior from day
 * detail: hardcoded `wo_show` callback lands on week_overview. Proposal
 * 003's audit explicitly named this decision; this scenario locks it.
 */

import { assertLastRenderedView } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 027 audit lock: from day_detail, tapping "← Back to week" lands on ' +
  'week_overview (the hardcoded wo_show callback). A future dispatcher-' +
  'driven back computation that differs would surface as a visible diff.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertLastRenderedView(ctx, { surface: 'plan', view: 'week_overview' });

  // The specific journey: my_plan → wo_show → dd_<date> → wo_show.
  const handlers = ctx.execTrace.handlers;
  const expected = [
    'menu:my_plan',
    'callback:wo_show',
    'callback:dd_2026-04-09',
    'callback:wo_show',
  ];
  for (const step of expected) {
    if (!handlers.includes(step)) {
      throw new Error(
        `Expected handler "${step}" in trace; got [${handlers.join(', ')}].`,
      );
    }
  }
}
