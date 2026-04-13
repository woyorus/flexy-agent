/**
 * Scenario-local assertions for 027-reproposer-clarification.
 *
 * Plan 032 Wave C — vague request triggers re-proposer clarification; the
 * user's follow-up clarifies and the plan updates. Two dispatcher actions:
 * first `clarify` (the re-proposer asked a question), then `mutate_plan`
 * once the user's follow-up is actionable.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A vague mutation request triggers a re-proposer clarification; the ' +
  'user\'s specific follow-up routes through mutate_plan, lands on the ' +
  're-proposer, and the final plan reflects the clarified request with ' +
  'mutationHistory length 1.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['clarify', 'mutate_plan']);
  assertMutationHistoryLength(ctx, 1);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
