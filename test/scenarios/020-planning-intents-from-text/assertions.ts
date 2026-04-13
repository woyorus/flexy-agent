/**
 * Scenario-local assertions for 020-planning-intents-from-text.
 *
 * Plan 032 Wave C — two free-text intents mid-planning:
 *   1. "Put the flex meal on Sunday instead" during proposal phase →
 *      dispatcher → mutate_plan → re-proposer.
 *   2. "Start over" → meta-intent short-circuit; flow resets.
 *
 * After the reset, the user completes a fresh plan and approves. Since
 * the final session is the post-reset one, its mutationHistory is empty
 * (the pre-reset mutation does not carry over).
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Free-text mutations during the proposal phase route through mutate_plan; ' +
  '"start over" short-circuits and resets the flow; the restarted plan is ' +
  'persisted cleanly with a fresh (empty) mutation history.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);

  // Dispatcher sees the mutation text, but "start over" short-circuits
  // (not a dispatcher action). Only one mutate_plan fires.
  assertDispatcherActions(ctx, ['mutate_plan']);

  // After reset, the approved session has no mutations.
  assertMutationHistoryLength(ctx, 0);

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
