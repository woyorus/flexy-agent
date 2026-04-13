/**
 * Scenario-local assertions for 004-rolling-first-plan.
 *
 * Plan 032 Wave A — cold-start path: no prior sessions, no batches.
 * computeNextHorizonStart falls back to "tomorrow" (D30 cold-start rule).
 */

import { assertPlanningHealthy } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'With no prior plan session, the first session\'s horizonStart is ' +
  'tomorrow (not today), the plan covers tomorrow through D6 end-to-end, ' +
  'and it persists via confirmPlanSession.';

interface SessionShape {
  id: string;
  horizonStart?: string;
  horizonEnd?: string;
  supersededBy?: unknown;
}

function tomorrowIsoFromClock(clockIso: string): string {
  const d = new Date(clockIso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function assertBehavior(ctx: AssertionsContext): void {
  // 1. Planning health (including retry-recovered plans — the scenario
  //    happens to exercise a validator retry; that's still a healthy plan
  //    once the retry succeeds).
  assertPlanningHealthy(ctx);

  // 2. horizonStart is tomorrow relative to the spec's clock.
  const session = ctx.activeSession() as SessionShape | undefined;
  if (!session) {
    throw new Error('Expected an active plan session; got none.');
  }
  const expectedStart = tomorrowIsoFromClock(ctx.spec.clock);
  if (session.horizonStart !== expectedStart) {
    throw new Error(
      `Expected horizonStart=${expectedStart} (tomorrow relative to clock ${ctx.spec.clock}); ` +
        `got ${session.horizonStart}.`,
    );
  }

  // 3. Persistence.
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error('Expected a `confirmPlanSession` persistence op; got none.');
  }
}
