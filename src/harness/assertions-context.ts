/**
 * `AssertionsContext` — the input surface for a scenario's
 * `assertBehavior(ctx)` function.
 *
 * Plan 031 introduces scenario-local `assertions.ts` modules that export
 * deterministic semantic checks over the scenario's outcome. Those checks
 * receive a single `ctx` object carrying the inputs (`spec`, `outputs`,
 * `finalSession`, `finalStore`, `sessionAt`, `execTrace`) plus a small set
 * of readonly convenience accessors computed on demand from the above.
 *
 * Every field is readonly: assertions are semantic observers, not
 * mutators. The convenience accessors are functions rather than precomputed
 * properties so the cost of computing them is paid only when an assertion
 * actually asks.
 */

import type { Scenario, CapturedOutput } from './types.js';
import type { ExecTrace } from './trace.js';

/**
 * Context passed to `assertBehavior(ctx)`.
 *
 * Access patterns:
 *   - `ctx.outputs[i]` — the captured transcript, in order.
 *   - `ctx.finalStore` — the in-memory store snapshot at end of scenario.
 *     Shape mirrors `TestStateStore.snapshot()` — `{ session, planSessions,
 *     batches, measurements }`.
 *   - `ctx.finalSession` — `BotCore.session` at end of scenario.
 *   - `ctx.execTrace` — runtime observables from Plan 031's trace hooks.
 *     Grouped by event kind.
 *   - `ctx.activeSession()` — first non-superseded `planSession` in
 *     `finalStore`, or `undefined` if none.
 *   - `ctx.batches()` — `finalStore.batches` as an array, empty if missing.
 *   - `ctx.flexSlots()` — the active session's `flexSlots` array, empty if
 *     no active session or the session has no flex entries.
 *   - `ctx.lastOutput()` — `outputs[outputs.length - 1]`, `undefined` when
 *     the transcript is empty.
 *   - `ctx.replyContaining(needle)` — the first output whose `text`
 *     includes `needle`, or `undefined`.
 */
export interface AssertionsContext {
  readonly spec: Scenario;
  readonly outputs: readonly CapturedOutput[];
  readonly finalSession: unknown;
  readonly finalStore: unknown;
  readonly sessionAt?: readonly unknown[];
  readonly execTrace: ExecTrace;

  readonly activeSession: () => unknown;
  readonly batches: () => readonly unknown[];
  readonly flexSlots: () => readonly unknown[];

  readonly lastOutput: () => CapturedOutput | undefined;
  readonly replyContaining: (needle: string) => CapturedOutput | undefined;
}

/**
 * Shape of `finalStore` for the purposes of derived accessors. The real
 * snapshot shape (in `TestStateStore.snapshot()`) has richer typing; we
 * intentionally narrow to just the fields the accessors need and tolerate
 * missing keys so assertions can run against partial/stub contexts in
 * unit tests.
 */
interface StoreLike {
  planSessions?: unknown;
  batches?: unknown;
}

interface PlanSessionLike {
  status?: unknown;
  supersededBy?: unknown;
  flexSlots?: unknown;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function findActiveSession(finalStore: unknown): unknown {
  const store = finalStore as StoreLike | null | undefined;
  if (!store || typeof store !== 'object') return undefined;
  const sessions = asArray(store.planSessions);
  for (const session of sessions) {
    const s = session as PlanSessionLike | null | undefined;
    if (!s || typeof s !== 'object') continue;
    // A "non-superseded" session is one whose `supersededBy` is null/absent.
    if (s.supersededBy === null || s.supersededBy === undefined) {
      return session;
    }
  }
  return undefined;
}

export interface BuildAssertionsContextInput {
  spec: Scenario;
  outputs: readonly CapturedOutput[];
  finalSession: unknown;
  finalStore: unknown;
  sessionAt?: readonly unknown[];
  execTrace: ExecTrace;
}

/**
 * Construct a frozen `AssertionsContext` from runner outputs. The
 * convenience accessors close over the provided values; they re-traverse
 * the store on every call, but since assertions are short-lived the cost
 * is negligible and the alternative (caching) would complicate invalidation.
 */
export function buildAssertionsContext(
  input: BuildAssertionsContextInput,
): AssertionsContext {
  const ctx: AssertionsContext = {
    spec: input.spec,
    outputs: input.outputs,
    finalSession: input.finalSession,
    finalStore: input.finalStore,
    sessionAt: input.sessionAt,
    execTrace: input.execTrace,

    activeSession: () => findActiveSession(input.finalStore),
    batches: () => {
      const store = input.finalStore as StoreLike | null | undefined;
      if (!store || typeof store !== 'object') return [];
      return asArray(store.batches);
    },
    flexSlots: () => {
      const session = findActiveSession(input.finalStore) as PlanSessionLike | undefined;
      if (!session) return [];
      return asArray(session.flexSlots);
    },

    lastOutput: () => (input.outputs.length === 0 ? undefined : input.outputs[input.outputs.length - 1]),
    replyContaining: (needle: string) =>
      input.outputs.find((o) => typeof o.text === 'string' && o.text.includes(needle)),
  };
  return Object.freeze(ctx);
}
