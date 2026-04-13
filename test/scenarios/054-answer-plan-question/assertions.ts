/**
 * Scenario-local assertions for 054-answer-plan-question.
 *
 * Plan 032 Wave I — dispatcher picks answer_plan_question for a plan-
 * scoped question. Inline reply; no state changes.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A plan-scoped question ("when\'s my next cook day?") routes through ' +
  'answer_plan_question; the reply is inline text; no persistence, no ' +
  'flow entered.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['answer_plan_question']);
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error('Expected zero persistence ops.');
  }
}
