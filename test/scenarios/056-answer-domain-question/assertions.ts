/**
 * Scenario-local assertions for 056-answer-domain-question.
 *
 * Plan 032 Wave I — dispatcher picks answer_domain_question for a
 * general nutrition/cooking question.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A domain question ("substitute for tahini?") routes through ' +
  'answer_domain_question; the reply is inline; no persistence or flow ' +
  'state changes.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['answer_domain_question']);
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error('Expected zero persistence ops.');
  }
}
