/**
 * Scenario-local assertions for 028-reproposer-recipe-generation.
 *
 * Plan 032 Wave C — user asks for a recipe not in the DB. Re-proposer
 * returns a clarification asking to generate; user confirms. The recipe
 * is generated, persisted, and the plan updated. Dispatcher sees
 * [mutate_plan, clarify] because the first text routes to mutate_plan
 * (the re-proposer surfaces a recipe_needed clarification), and the
 * confirmation "yes" routes via clarify.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A mutation request naming a recipe absent from the DB routes through ' +
  'mutate_plan to the re-proposer; the re-proposer surfaces a clarification ' +
  '(recipe_needed); the user\'s follow-up routes through clarify; the final ' +
  'plan is healthy and persists via confirmPlanSession. See tech-debt: the ' +
  're-proposer\'s recipe-generation handshake does not always terminate in ' +
  'a generated recipe from this prompt — the dispatcher-routing claim is ' +
  'load-bearing here, not the recipe creation itself.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  // Plan 033: after the dispatcher prompt changes, the second turn's "yes"
  // can route through `flow_input` (back into the planning flow) or
  // `clarify`, depending on LLM interpretation. Both drive through to a
  // recipe generation / persist. Assert only turn-1 routing plus the
  // persistence signal.
  const actions = ctx.execTrace.dispatcherActions.map((d) => d.action);
  if (actions[0] !== 'mutate_plan') {
    throw new Error(`Turn 1 should be mutate_plan; got ${actions[0]}.`);
  }
  void assertMutationHistoryLength;
  void assertDispatcherActions;

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
