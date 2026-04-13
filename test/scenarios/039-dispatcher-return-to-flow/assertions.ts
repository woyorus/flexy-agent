/**
 * Scenario-local assertions for 039-dispatcher-return-to-flow.
 *
 * Plan 032 Wave G — side question during planning routes to out_of_scope;
 * the subsequent "ok back to the plan" routes to return_to_flow which
 * re-renders the proposal and the user approves.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A side question during planning routes to out_of_scope; a follow-up ' +
  '"back to the plan" routes to return_to_flow which re-renders the ' +
  'proposal; the user approves and the plan persists healthily.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['out_of_scope', 'return_to_flow']);
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) throw new Error('Expected confirmPlanSession.');
}
