/**
 * Scenario 082 assertions: dispatcher routes recipe-level vs ingredient-level correctly.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Plan 033: dispatcher boundary — turn 1 picks mutate_plan, turn 2 picks swap_ingredient.';

export function assertBehavior(ctx: AssertionsContext): void {
  const actions = ctx.execTrace.dispatcherActions.map((d) => d.action);
  if (actions[0] !== 'mutate_plan') {
    throw new Error(`Turn 1 should route to mutate_plan; got ${actions[0]}.`);
  }
  if (actions[1] !== 'swap_ingredient') {
    throw new Error(`Turn 2 should route to swap_ingredient; got ${actions[1]}.`);
  }
}
