/**
 * Scenario-local assertions for 055-answer-recipe-question.
 *
 * Plan 032 Wave I — dispatcher picks answer_recipe_question while the
 * user is on the cook view.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'From a cook view, a recipe-scoped question ("can I freeze this?") ' +
  'routes through answer_recipe_question; the reply is inline; no ' +
  'persistence, no flow state changes.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['answer_recipe_question']);
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error('Expected zero persistence ops.');
  }
}
