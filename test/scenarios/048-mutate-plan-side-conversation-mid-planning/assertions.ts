/**
 * Scenario-local assertions for 048-mutate-plan-side-conversation-mid-planning.
 *
 * Plan 032 Wave H — user opens planFlow, types a mutation, then an
 * off-topic question, then another mutation; planFlow is preserved across
 * the out_of_scope detour. Final plan persists via confirmPlanSession.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'During an active planFlow, a mutation → out-of-topic question → another ' +
  'mutation sequence preserves planFlow state across the out_of_scope ' +
  'detour; both mutations land; the user approves and persistence runs ' +
  'via confirmPlanSession (first confirmation).';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['mutate_plan', 'out_of_scope', 'mutate_plan']);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) throw new Error('Expected confirmPlanSession.');
}
