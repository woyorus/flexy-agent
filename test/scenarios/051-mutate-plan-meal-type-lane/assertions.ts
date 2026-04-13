/**
 * Scenario-local assertions for 051-mutate-plan-meal-type-lane.
 *
 * Plan 032 Wave H — regression lock for re-proposer invariant #14. A
 * lane-crossing mutation (trying to move a lunch batch into a dinner slot
 * or vice versa) must be caught by the invariant validator. The scenario
 * captures the rejection path: dispatcher picks mutate_plan, the mutation
 * is declined, no persistence.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'A lane-crossing mutation attempt routes through mutate_plan but is ' +
  'rejected by the re-proposer invariant validator; no persistence op ' +
  'runs and the plan is not modified. Regression lock for invariant #14.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['mutate_plan']);

  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps.map((o) => o.op).join(', ')}.`,
    );
  }
}
