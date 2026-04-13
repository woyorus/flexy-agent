/**
 * Scenario-local assertions for 025-reproposer-event-remove.
 *
 * Plan 032 Wave C — user adds an event during event collection, sees it
 * baked into the proposal, then asks to remove it. First text during
 * event collection routes to flow_input; the remove text routes to
 * mutate_plan and the re-proposer fills the freed slot.
 */

import {
  assertPlanningHealthy,
  assertDispatcherActions,
  assertMutationHistoryLength,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'The event-add text routes through flow_input; the later "remove it" ' +
  'text routes through mutate_plan, the re-proposer fills the freed slot, ' +
  'mutationHistory grows to 1, and the final plan has no events.';

interface SessionShape {
  events?: unknown[];
}

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertDispatcherActions(ctx, ['flow_input', 'mutate_plan']);

  // Exactly one mutation (the removal); the event-add during collection
  // doesn't count as a mutation of a confirmed proposal.
  assertMutationHistoryLength(ctx, 1);

  // Final session has no events (the removed one is gone).
  const session = ctx.activeSession() as SessionShape | undefined;
  const events = Array.isArray(session?.events) ? session.events : [];
  if (events.length !== 0) {
    throw new Error(
      `Expected final session events=[]; got ${events.length} entries.`,
    );
  }

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected confirmPlanSession; got none.');
  }
}
