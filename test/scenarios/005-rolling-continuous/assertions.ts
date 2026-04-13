/**
 * Scenario-local assertions for 005-rolling-continuous.
 *
 * Plan 032 Wave B — rolling-horizon core: session A is already confirmed
 * with a batch that extends into session B's horizon (pre-committed
 * carry-over). Session B plans the next 7 days; the proposer must respect
 * the carry-over slot.
 */

import {
  assertPlanningHealthy,
  assertRollingCarryOver,
  assertNoBatchOverlapsPriorSession,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'With session A already confirmed and containing a batch whose eating ' +
  'days extend into session B\'s horizon, session B\'s plan covers every ' +
  'slot in its horizon without double-booking the pre-committed carry-over.';

export function assertBehavior(ctx: AssertionsContext): void {
  // 1. Session B (the latest session) is healthy.
  assertPlanningHealthy(ctx);

  // 2. A carry-over batch from a prior session exists in B's horizon.
  assertRollingCarryOver(ctx);

  // 3. No new batch in B collides with a carry-over slot.
  assertNoBatchOverlapsPriorSession(ctx);

  // 4. B was persisted.
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected a `confirmPlanSession` persistence op; got none.');
  }
}
