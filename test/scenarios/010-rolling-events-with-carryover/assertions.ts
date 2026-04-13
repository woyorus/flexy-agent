/**
 * Scenario-local assertions for 010-rolling-events-with-carryover.
 *
 * Plan 032 Wave B — pre-committed carry-over + restaurant event + flex
 * all in the same horizon. Exercises the proposer's ability to respect
 * three constraint types simultaneously.
 */

import {
  assertPlanningHealthy,
  assertRollingCarryOver,
  assertNoBatchOverlapsPriorSession,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'With pre-committed carry-over, a restaurant event, and a flex slot all ' +
  'in the same horizon, the proposer produces a healthy plan that respects ' +
  'every constraint — no double-bookings across carry-over, event, or flex.';

interface SessionShape {
  flexSlots?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  events?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
}

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertRollingCarryOver(ctx);
  assertNoBatchOverlapsPriorSession(ctx);

  // The session actually has both an event and a flex slot.
  const session = ctx.activeSession() as SessionShape | undefined;
  if (!session) throw new Error('Expected an active session; got none.');
  if (!session.events || session.events.length === 0) {
    throw new Error('Expected at least one event in the active session; got none.');
  }
  if (!session.flexSlots || session.flexSlots.length === 0) {
    throw new Error('Expected at least one flex slot in the active session; got none.');
  }

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected a `confirmPlanSession` persistence op; got none.');
  }
}
