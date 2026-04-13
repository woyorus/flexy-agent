/**
 * Scenario-local assertions for 006-rolling-gap-vacation.
 *
 * Plan 032 Wave B — vacation fallback: session A is historical
 * (horizonEnd < clock), so computeNextHorizonStart falls back to "tomorrow"
 * with no pre-committed carry-over.
 */

import { assertPlanningHealthy } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'When the only prior session is fully in the past (vacation gap), the ' +
  'rolling-horizon fallback starts the new horizon tomorrow with no ' +
  'pre-committed carry-over; the new plan covers every slot end-to-end.';

interface SessionShape {
  id: string;
  horizonStart?: string;
  superseded?: boolean;
}

interface BatchShape {
  createdInPlanSessionId?: string;
  eatingDays?: string[];
}

function tomorrowIsoFromClock(clockIso: string): string {
  const d = new Date(clockIso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);

  // The latest non-superseded session (session B) starts tomorrow.
  const session = ctx.activeSession() as SessionShape | undefined;
  if (!session) {
    throw new Error('Expected an active plan session; got none.');
  }
  const expectedStart = tomorrowIsoFromClock(ctx.spec.clock);
  if (session.horizonStart !== expectedStart) {
    throw new Error(
      `Expected horizonStart=${expectedStart} (tomorrow); got ${session.horizonStart}.`,
    );
  }

  // No carry-over batches: no batch from another session with eating days
  // in B's horizon. (We check by session linkage — the historical session's
  // batches all have eating days in the past.)
  const batches = ctx.batches() as readonly BatchShape[];
  const carryOver = batches.filter(
    (b) => b.createdInPlanSessionId !== undefined && b.createdInPlanSessionId !== session.id,
  );
  // Some carry-over batches from session A may be in the store but should
  // have no eating days in B's horizon (all before B's horizonStart).
  for (const b of carryOver) {
    if (!b.eatingDays) continue;
    const overlaps = b.eatingDays.some((d) => d >= expectedStart);
    if (overlaps) {
      throw new Error(
        `Unexpected carry-over: a prior-session batch has eating days in or after ${expectedStart}.`,
      );
    }
  }

  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected a `confirmPlanSession` persistence op; got none.');
  }
}
