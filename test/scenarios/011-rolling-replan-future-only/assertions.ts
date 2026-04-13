/**
 * Scenario-local assertions for 011-rolling-replan-future-only.
 *
 * Plan 032 Wave B — D27 replan happy path: session A is running, session B
 * is future-only. User taps Plan Week, is prompted to replan B, confirms,
 * completes a new plan. Old B is superseded, old B's batches cancelled,
 * new session C takes its place.
 */

import {
  assertPlanningHealthy,
  assertSaveBeforeDestroy,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Replanning a future-only session produces a new session for the same ' +
  'horizon, supersedes the old one, cancels all its batches, and persists ' +
  'via confirmPlanSessionReplacing — the save-before-destroy guarantee.';

const OLD_SESSION_ID = 'session-b-future-00000000-0000-0000-0000-000000000002';

export function assertBehavior(ctx: AssertionsContext): void {
  assertPlanningHealthy(ctx);
  assertSaveBeforeDestroy(ctx, OLD_SESSION_ID);

  // Persistence must use the replacing path, not the plain confirm.
  const usedReplacing = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSessionReplacing',
  );
  if (!usedReplacing) {
    throw new Error(
      'Expected a `confirmPlanSessionReplacing` persistence op; got only: ' +
        ctx.execTrace.persistenceOps.map((o) => o.op).join(', '),
    );
  }
}
