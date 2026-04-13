/**
 * Scenario-local assertions for 001-plan-week-happy-path.
 *
 * Plan 032 Wave A — the simplest planning scenario: fresh user completes
 * a full planning flow end-to-end (Plan Week → keep breakfast → no events
 * → approve). Locks the claim that the planning happy path produces a
 * complete, healthy 7-day plan and persists it without validator retries.
 */

import { assertPlanningHealthy } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'From an empty state, the planning flow produces a complete 7-day plan ' +
  'that covers every slot, passes validation on the first proposer call, ' +
  'persists via confirmPlanSession, and clears planFlow on approval.';

export function assertBehavior(ctx: AssertionsContext): void {
  // 1. Planning health — slot coverage, no ghosts, batch sizing, cook days,
  //    weekly totals absorbed.
  assertPlanningHealthy(ctx);

  // 2. Persistence via confirmPlanSession (first confirmation — non-replacing).
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSession',
  );
  if (!persisted) {
    throw new Error(
      'Expected a `confirmPlanSession` persistence op; got none.',
    );
  }

  // 3. No validator retries — happy path means the first proposer response
  //    validated cleanly.
  if (ctx.execTrace.validatorRetries.length > 0) {
    throw new Error(
      `Happy path should have zero validator retries; got ${ctx.execTrace.validatorRetries.length}.`,
    );
  }

  // 4. planFlow is cleared after approval.
  const session = ctx.finalSession as { planFlow?: unknown } | null | undefined;
  if (session && session.planFlow !== null && session.planFlow !== undefined) {
    throw new Error(
      `Expected finalSession.planFlow to be null after approval; got ${JSON.stringify(session.planFlow)?.slice(0, 80)}.`,
    );
  }
}
