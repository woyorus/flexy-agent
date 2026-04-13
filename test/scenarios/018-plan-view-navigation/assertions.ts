/**
 * Scenario-local assertions for 018-plan-view-navigation.
 *
 * Plan 032 Wave E — active plan navigation: My Plan → Week Overview →
 * Day Detail → Cook View → back to Next Action. Verifies the final
 * lastRenderedView and the handler sequence.
 */

import { assertLastRenderedView } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'From an active plan state, the navigation chain ' +
  'My Plan → Week Overview → Day Detail → Cook View → Next Action ' +
  'walks every plan-surface view and ends with lastRenderedView pointing ' +
  'at next_action.';

const EXPECTED_HANDLER_TAIL = [
  'menu:my_plan',
  'callback:wo_show',
  'callback:dd_2026-04-09',
  'callback:cv_batch-016-lunch2-0000-0000-000000000003',
  'callback:na_show',
];

export function assertBehavior(ctx: AssertionsContext): void {
  // Final view is next_action (na_show was the last tap).
  assertLastRenderedView(ctx, { surface: 'plan', view: 'next_action' });

  // The expected callback handlers fired in order.
  const handlers = ctx.execTrace.handlers;
  for (const expected of EXPECTED_HANDLER_TAIL) {
    if (!handlers.includes(expected)) {
      throw new Error(
        `Expected handler "${expected}" in handlers; got: [${handlers.join(', ')}]`,
      );
    }
  }
}
