/**
 * Scenario-local assertions for 050-mutate-plan-no-target.
 *
 * Plan 032 Wave H — user types a mutation without any active plan. The
 * dispatcher picks `clarify` (no target to mutate); no persistence. The
 * scenario locks the no-target guidance response.
 */

import { assertDispatcherActions } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'With no active plan, a mutation-shaped text routes through the ' +
  'dispatcher to clarify (no target to act on); no persistence ops run ' +
  'and the store has no plan sessions.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['clarify']);

  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops; got: ${ctx.execTrace.persistenceOps.map((o) => o.op).join(', ')}.`,
    );
  }

  const store = ctx.finalStore as { planSessions?: unknown[] } | null | undefined;
  const sessions = Array.isArray(store?.planSessions) ? store.planSessions : [];
  if (sessions.length !== 0) {
    throw new Error(
      `Expected no plan sessions in store; got ${sessions.length}.`,
    );
  }
}
