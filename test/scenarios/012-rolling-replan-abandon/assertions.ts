/**
 * Scenario-local assertions for 012-rolling-replan-abandon.
 *
 * Plan 032 Wave B — save-before-destroy guarantee: user replans future
 * session B, enters the draft, then taps /cancel before Approve. Session B
 * must remain fully intact — superseded=false, batches still planned,
 * no persistence op ran.
 */

import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Abandoning a replan mid-draft leaves the original session fully intact: ' +
  'it is not marked superseded, its batches stay planned, and no ' +
  'confirmPlanSession/confirmPlanSessionReplacing op ran.';

const OLD_SESSION_ID = 'session-b-future-00000000-0000-0000-0000-000000000002';

interface SessionShape {
  id: string;
  superseded?: boolean;
}

interface BatchShape {
  createdInPlanSessionId?: string;
  status: 'planned' | 'cancelled';
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function assertBehavior(ctx: AssertionsContext): void {
  const store = ctx.finalStore as
    | { planSessions?: unknown; batches?: unknown }
    | null
    | undefined;
  const sessions = asArray<SessionShape>(store?.planSessions);

  // 1. Old session B is still present and not superseded.
  const oldSession = sessions.find((s) => s.id === OLD_SESSION_ID);
  if (!oldSession) {
    throw new Error(`Expected session id=${OLD_SESSION_ID} still in store; not found.`);
  }
  if (oldSession.superseded === true) {
    throw new Error('Expected old session to remain superseded=false after cancel; got true.');
  }

  // 2. Old session's batches still planned, not cancelled.
  const batches = asArray<BatchShape>(store?.batches);
  const oldBatches = batches.filter((b) => b.createdInPlanSessionId === OLD_SESSION_ID);
  if (oldBatches.length === 0) {
    throw new Error(`Expected old-session batches present in store; found none.`);
  }
  const cancelled = oldBatches.filter((b) => b.status === 'cancelled');
  if (cancelled.length > 0) {
    throw new Error(
      `Expected all old-session batches to remain planned; ${cancelled.length} are cancelled.`,
    );
  }

  // 3. No new confirmed session.
  const newSessions = sessions.filter((s) => s.id !== OLD_SESSION_ID);
  // Session A (running) is allowed — check the store spec. Anything that
  // looks like a replacement of B (same/later horizon) would indicate
  // destroy-before-save. We detect it by the presence of persistence ops.
  if (newSessions.length > 1) {
    // Only session A is expected besides OLD_SESSION_ID.
  }

  // 4. No persistence op ran.
  if (ctx.execTrace.persistenceOps.length > 0) {
    throw new Error(
      `Expected zero persistence ops after cancel; got: ` +
        ctx.execTrace.persistenceOps.map((o) => o.op).join(', '),
    );
  }
}
