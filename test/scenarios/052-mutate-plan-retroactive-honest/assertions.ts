/**
 * Scenario-local assertions for 052-mutate-plan-retroactive-honest.
 *
 * Plan 032 Wave H — retroactive "last night I went to Indian" mutation.
 * Per tech-debt TD-007, the current behavior silently drops the user's
 * retroactive event. The recording captures this (known-buggy) behavior;
 * the scenario is certified around the routing path, and TD-007 tracks
 * the product fix (design-docs/proposals/005-honest-past-logging.md).
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A retroactive eat-out mutation ("last night I went to Indian") routes ' +
  'through mutate_plan; mp_confirm persists via confirmPlanSessionReplacing. ' +
  'See TD-007: the current re-proposer behavior silently drops the user\'s ' +
  'past-event input (validator rejects, retry produces unrelated filler). ' +
  'Certified around the routing + persistence path; honest-past-logging ' +
  'design doc 005 owns the fix.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['mutate_plan']);

  if (!ctx.execTrace.handlers.includes('callback:mp_confirm')) {
    throw new Error('Expected callback:mp_confirm; not found.');
  }

  const replacing = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'confirmPlanSessionReplacing',
  );
  if (!replacing) {
    throw new Error('Expected confirmPlanSessionReplacing; got none.');
  }
}
