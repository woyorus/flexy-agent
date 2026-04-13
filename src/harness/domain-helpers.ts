/**
 * Reusable domain assertion helpers for scenario-local `assertBehavior`.
 *
 * Plan 031 Phase 4. Each primitive is a pure function over an
 * `AssertionsContext` that throws `Error` with an actionable message on
 * failure. `assertPlanningHealthy` composes the seven primitives that
 * mirror the 5-step verification protocol in
 * `docs/product-specs/testing.md` § "Verifying recorded output".
 *
 * Composition policy:
 *   - Primitives are independently useful — scenarios that want only the
 *     "no ghost batches" check can import just that.
 *   - `assertPlanningHealthy` aggregates every primitive's failure into a
 *     single thrown error so the agent sees every broken check at once
 *     (rather than fix-regenerate-rerun cycling through them serially).
 *
 * What "healthy" means here = what the 5-step protocol exists to catch:
 *   - Every slot in the active horizon is sourced (batch / event / flex /
 *     pre-committed) exactly once.
 *   - No batch has zero-calorie macros (a "ghost batch" — the proposer
 *     returned servings=0 or the solver scaled a batch to nothing).
 *   - No batch has servings outside [1, 3] (Plan 024's allowed range).
 *   - Every batch's cook day equals its first eating day (cook-day
 *     derivation invariant; a divergence signals a solver or display bug).
 *   - No output text warns that weekly totals are off target (the proposer
 *     emits a ⚠ annotation when macro absorption fails; its presence is
 *     the proposer's own signal that something slipped past tolerance).
 *
 * None of this is LLM judgment. Every primitive walks the on-disk
 * `finalStore` / `finalSession` / `outputs` and decides deterministically.
 */

import type { AssertionsContext } from './assertions-context.js';
import type { CapturedOutput } from './types.js';

// ─── Narrow shapes used by the primitives ───────────────────────────────────

interface PlanSessionShape {
  id: string;
  horizonStart: string;
  horizonEnd: string;
  superseded?: boolean;
  flexSlots?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  events?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
}

interface BatchShape {
  id: string;
  recipeSlug?: string;
  mealType: 'lunch' | 'dinner';
  eatingDays: string[];
  servings: number;
  status: 'planned' | 'cancelled';
  createdInPlanSessionId?: string;
  actualPerServing?: { calories?: number };
}

interface PlanFlowShape {
  events?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  flexSlots?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  preCommittedSlots?: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
}

interface FinalStoreShape {
  planSessions?: unknown;
  batches?: unknown;
}

interface FinalSessionShape {
  planFlow?: PlanFlowShape | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Resolve the active planning context:
 *   - If `finalSession.planFlow` is in the proposal phase (evidenced by
 *     non-null planFlow with events/flexSlots arrays), use it. That's the
 *     in-session case — no session has been persisted yet.
 *   - Otherwise, fall back to the first non-superseded planSession in the
 *     store. That's the post-confirmation case — the plan has been
 *     persisted.
 *
 * Returns `undefined` if neither applies (non-planning scenario).
 */
function resolveActiveContext(ctx: AssertionsContext): {
  horizonDays: string[];
  events: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  flexSlots: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  preCommittedSlots: Array<{ day: string; mealTime: 'lunch' | 'dinner' }>;
  batches: BatchShape[];
  sessionId?: string;
} | undefined {
  const finalSession = ctx.finalSession as FinalSessionShape | null | undefined;
  const finalStore = ctx.finalStore as FinalStoreShape | null | undefined;
  const allBatches = asArray<BatchShape>(finalStore?.batches);
  const activeBatches = allBatches.filter((b) => b.status !== 'cancelled');

  // Post-confirmation path: pick the LATEST non-superseded session (by
  // horizonStart). In rolling scenarios, multiple non-superseded sessions
  // may coexist (session A is completed normally; session B is newly
  // confirmed for the next horizon). We want to validate the most recent
  // plan, not an older one.
  const sessions = asArray<PlanSessionShape>(finalStore?.planSessions);
  const nonSuperseded = sessions.filter((s) => s.superseded !== true);
  nonSuperseded.sort((a, b) => a.horizonStart.localeCompare(b.horizonStart));
  const active = nonSuperseded[nonSuperseded.length - 1];
  if (active) {
    const horizonDays = daysBetween(active.horizonStart, active.horizonEnd);
    const horizonSet = new Set(horizonDays);
    // Batches relevant to the active horizon:
    //   (a) batches created in the active session, OR
    //   (b) carry-over batches: created in a prior session but with eating
    //       days that fall in the active horizon.
    //   (c) legacy: batches without createdInPlanSessionId (older scenarios).
    const batchesForActive = activeBatches.filter((b) => {
      if (b.createdInPlanSessionId === active.id) return true;
      if (b.createdInPlanSessionId === undefined) return true;
      return Array.isArray(b.eatingDays) && b.eatingDays.some((d) => horizonSet.has(d));
    });
    return {
      horizonDays,
      events: active.events ?? [],
      flexSlots: active.flexSlots ?? [],
      preCommittedSlots: [],
      batches: batchesForActive,
      sessionId: active.id,
    };
  }

  // In-session path: use planFlow's in-memory structure.
  const flow = finalSession?.planFlow;
  if (flow && (flow.events || flow.flexSlots || flow.preCommittedSlots)) {
    return {
      // In-session horizonDays are on state; scenarios that want to use this
      // primitive during in-session should ensure finalSession.planFlow has
      // the necessary structure. The fallback below derives from events/flex
      // slot dates when horizon isn't directly accessible.
      horizonDays: deriveHorizonFromSlots(flow),
      events: flow.events ?? [],
      flexSlots: flow.flexSlots ?? [],
      preCommittedSlots: flow.preCommittedSlots ?? [],
      batches: activeBatches,
    };
  }

  return undefined;
}

function daysBetween(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const start = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function deriveHorizonFromSlots(flow: PlanFlowShape): string[] {
  const days = new Set<string>();
  for (const e of flow.events ?? []) days.add(e.day);
  for (const f of flow.flexSlots ?? []) days.add(f.day);
  for (const p of flow.preCommittedSlots ?? []) days.add(p.day);
  return [...days].sort();
}

// ─── Primitives ─────────────────────────────────────────────────────────────

/**
 * Every (day × mealTime) slot in the horizon is covered by exactly one of:
 * batch eating day, meal event, flex slot, pre-committed slot. Uses the
 * active context from `resolveActiveContext`.
 *
 * Composes `assertNoOrphanSlots` + `assertNoDoubleBooking`; exported
 * separately so scenarios that want the full picture in one message can
 * call this.
 */
export function assertSlotCoverage(ctx: AssertionsContext): void {
  const active = resolveActiveContext(ctx);
  if (!active) return; // non-planning scenario — nothing to check

  const expectedSlots: string[] = [];
  for (const day of active.horizonDays) {
    expectedSlots.push(`${day}:lunch`);
    expectedSlots.push(`${day}:dinner`);
  }

  const coverage = new Map<string, string[]>();
  const record = (key: string, source: string) => {
    const list = coverage.get(key) ?? [];
    list.push(source);
    coverage.set(key, list);
  };
  for (const b of active.batches) {
    for (const day of b.eatingDays) {
      record(`${day}:${b.mealType}`, `batch ${b.recipeSlug ?? b.id}`);
    }
  }
  for (const e of active.events) record(`${e.day}:${e.mealTime}`, 'event');
  for (const f of active.flexSlots) record(`${f.day}:${f.mealTime}`, 'flex');
  for (const p of active.preCommittedSlots) record(`${p.day}:${p.mealTime}`, 'pre-committed');

  const errors: string[] = [];
  for (const slot of expectedSlots) {
    const sources = coverage.get(slot);
    if (!sources || sources.length === 0) {
      errors.push(`slot ${slot} has no source (orphan)`);
    } else if (sources.length > 1) {
      errors.push(`slot ${slot} is double-booked: ${sources.join(', ')}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`slot coverage violated:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * No batch in `finalStore.batches` has `actualPerServing.calories === 0`.
 * Ghost batches (zero-calorie) indicate a solver scaled to nothing or a
 * proposer emitted `servings: 0`.
 */
export function assertNoGhostBatches(ctx: AssertionsContext): void {
  const batches = ctx.batches() as readonly BatchShape[];
  const offenders = batches.filter(
    (b) => b.status !== 'cancelled' && (b.actualPerServing?.calories ?? 0) === 0,
  );
  if (offenders.length > 0) {
    throw new Error(
      `${offenders.length} ghost batch(es) with zero-calorie macros:\n  - ` +
        offenders.map((b) => `${b.recipeSlug ?? b.id} (${b.mealType})`).join('\n  - '),
    );
  }
}

/**
 * No day × meal slot has zero sources. Composed into `assertSlotCoverage`;
 * exported separately for orphan-only checks.
 */
export function assertNoOrphanSlots(ctx: AssertionsContext): void {
  const active = resolveActiveContext(ctx);
  if (!active) return;
  const covered = new Set<string>();
  for (const b of active.batches) for (const day of b.eatingDays) covered.add(`${day}:${b.mealType}`);
  for (const e of active.events) covered.add(`${e.day}:${e.mealTime}`);
  for (const f of active.flexSlots) covered.add(`${f.day}:${f.mealTime}`);
  for (const p of active.preCommittedSlots) covered.add(`${p.day}:${p.mealTime}`);

  const orphans: string[] = [];
  for (const day of active.horizonDays) {
    for (const meal of ['lunch', 'dinner'] as const) {
      const key = `${day}:${meal}`;
      if (!covered.has(key)) orphans.push(key);
    }
  }
  if (orphans.length > 0) {
    throw new Error(`${orphans.length} orphan slot(s): ${orphans.join(', ')}`);
  }
}

/**
 * No day × meal slot has two or more sources. Same data as
 * `assertSlotCoverage`; exported separately for scenarios that want a
 * narrow check.
 */
export function assertNoDoubleBooking(ctx: AssertionsContext): void {
  const active = resolveActiveContext(ctx);
  if (!active) return;
  const coverage = new Map<string, string[]>();
  const push = (key: string, source: string) => {
    const list = coverage.get(key) ?? [];
    list.push(source);
    coverage.set(key, list);
  };
  for (const b of active.batches) for (const day of b.eatingDays) push(`${day}:${b.mealType}`, `batch:${b.recipeSlug ?? b.id}`);
  for (const e of active.events) push(`${e.day}:${e.mealTime}`, 'event');
  for (const f of active.flexSlots) push(`${f.day}:${f.mealTime}`, 'flex');
  for (const p of active.preCommittedSlots) push(`${p.day}:${p.mealTime}`, 'pre-committed');
  const doubles: string[] = [];
  for (const [key, sources] of coverage.entries()) {
    if (sources.length > 1) doubles.push(`${key} [${sources.join(', ')}]`);
  }
  if (doubles.length > 0) {
    throw new Error(`${doubles.length} double-booked slot(s):\n  - ${doubles.join('\n  - ')}`);
  }
}

/**
 * Every batch has `1 ≤ servings ≤ 3`. Plan 024's proposer explicitly allows
 * 1-serving batches as a last resort; scenarios that want the stricter
 * "no 1-serving batches here" guarantee enforce it themselves.
 */
export function assertBatchSizesSane(ctx: AssertionsContext): void {
  const batches = ctx.batches() as readonly BatchShape[];
  const offenders = batches.filter(
    (b) => b.status !== 'cancelled' && (b.servings < 1 || b.servings > 3),
  );
  if (offenders.length > 0) {
    throw new Error(
      `${offenders.length} batch(es) with servings outside [1, 3]:\n  - ` +
        offenders.map((b) => `${b.recipeSlug ?? b.id}: servings=${b.servings}`).join('\n  - '),
    );
  }
}

/**
 * Every batch's first eating day is its cook day. Since cook day is derived
 * as `eatingDays[0]` at display time (not stored separately), this check
 * verifies `eatingDays` is sorted ascending — a misordered array would
 * render a cook day that's *after* the first eating day.
 */
export function assertCookDayFirstEating(ctx: AssertionsContext): void {
  const batches = ctx.batches() as readonly BatchShape[];
  const offenders = batches.filter((b) => {
    if (b.status === 'cancelled') return false;
    if (!Array.isArray(b.eatingDays) || b.eatingDays.length === 0) return false;
    const sorted = [...b.eatingDays].sort();
    return sorted[0] !== b.eatingDays[0];
  });
  if (offenders.length > 0) {
    throw new Error(
      `${offenders.length} batch(es) where eatingDays[0] is not the earliest day:\n  - ` +
        offenders
          .map((b) => `${b.recipeSlug ?? b.id}: eatingDays=${JSON.stringify(b.eatingDays)}`)
          .join('\n  - '),
    );
  }
}

/**
 * No output text carries a ⚠️ annotation signalling that weekly macro
 * totals are off target after proposer/solver reconciliation. The proposer
 * emits this warning itself when absorption fails — seeing it in a golden
 * transcript means the run locked in a deviating plan, which is the exact
 * class of bug the review protocol is meant to catch.
 */
export function assertWeeklyTotalsAbsorbed(ctx: AssertionsContext): void {
  const offenders: CapturedOutput[] = [];
  for (const out of ctx.outputs) {
    if (typeof out.text !== 'string') continue;
    if (out.text.includes('⚠️') && /off target|below target|deviate|deviation/i.test(out.text)) {
      offenders.push(out);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `${offenders.length} output(s) warn that weekly totals are off target:\n  - ` +
        offenders.map((o) => o.text.slice(0, 120)).join('\n  - '),
    );
  }
}

// ─── Composed top-level helper ──────────────────────────────────────────────

/**
 * Run every planning primitive and aggregate failures into a single thrown
 * error. Preferred over calling each primitive individually because the
 * aggregated failure message surfaces every broken check at once.
 *
 * Primitives run in the order `assertSlotCoverage → assertNoGhostBatches →
 * assertNoOrphanSlots → assertNoDoubleBooking → assertBatchSizesSane →
 * assertCookDayFirstEating → assertWeeklyTotalsAbsorbed`.
 */
export function assertPlanningHealthy(ctx: AssertionsContext): void {
  const primitives: Array<(ctx: AssertionsContext) => void> = [
    assertSlotCoverage,
    assertNoGhostBatches,
    assertNoOrphanSlots,
    assertNoDoubleBooking,
    assertBatchSizesSane,
    assertCookDayFirstEating,
    assertWeeklyTotalsAbsorbed,
  ];
  const errors: string[] = [];
  for (const primitive of primitives) {
    try {
      primitive(ctx);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `assertPlanningHealthy failed:\n` + errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}

// ─── Rolling-horizon helpers (Plan 032 Wave B) ─────────────────────────────

/**
 * Assert that carry-over batches from prior sessions are actually present
 * in the active horizon — i.e. a rolling continuation didn't drop the
 * pre-committed slots.
 *
 * Rolling-horizon semantics: when a session's batch has eating days that
 * extend past its `horizonEnd`, those trailing days become pre-committed
 * slots in the next session. The batch is NOT re-created; it remains
 * linked to the prior session. After the next session confirms, the store
 * should show:
 *   - The prior session (non-superseded, its own horizon).
 *   - The new session (non-superseded, the new horizon).
 *   - The carry-over batch linked to the prior session, whose eating days
 *     span both horizons.
 *
 * This helper requires at least one such carry-over batch exists; the
 * scenario is expected to have been authored with pre-committed carry-over
 * as its premise. If no carry-over batches are found, the helper throws —
 * it is the scenario author's signal that rolling setup didn't land.
 */
export function assertRollingCarryOver(ctx: AssertionsContext): void {
  const finalStore = ctx.finalStore as FinalStoreShape | null | undefined;
  const sessions = asArray<PlanSessionShape>(finalStore?.planSessions);
  const nonSuperseded = sessions.filter((s) => s.superseded !== true);
  if (nonSuperseded.length < 2) {
    throw new Error(
      `assertRollingCarryOver expects >=2 non-superseded sessions in the store ` +
        `(prior + active); got ${nonSuperseded.length}.`,
    );
  }
  nonSuperseded.sort((a, b) => a.horizonStart.localeCompare(b.horizonStart));
  const active = nonSuperseded[nonSuperseded.length - 1];
  const horizonSet = new Set(daysBetween(active.horizonStart, active.horizonEnd));

  const allBatches = asArray<BatchShape>(finalStore?.batches).filter(
    (b) => b.status !== 'cancelled',
  );
  const carryOver = allBatches.filter(
    (b) =>
      b.createdInPlanSessionId !== undefined &&
      b.createdInPlanSessionId !== active.id &&
      Array.isArray(b.eatingDays) &&
      b.eatingDays.some((d) => horizonSet.has(d)),
  );
  if (carryOver.length === 0) {
    throw new Error(
      `Expected at least one carry-over batch (eating days in the active ` +
        `horizon but linked to a prior session); found none.`,
    );
  }
}

/**
 * Assert no new batch in the active session overlaps a carry-over slot.
 *
 * When session A has a batch whose eating days extend into session B's
 * horizon, session B's proposer must treat those (day, mealType) slots as
 * pre-committed and MUST NOT emit a new batch covering them. A double-
 * booking here is a rolling-horizon bug.
 */
export function assertNoBatchOverlapsPriorSession(ctx: AssertionsContext): void {
  const finalStore = ctx.finalStore as FinalStoreShape | null | undefined;
  const sessions = asArray<PlanSessionShape>(finalStore?.planSessions);
  const nonSuperseded = sessions.filter((s) => s.superseded !== true);
  if (nonSuperseded.length < 2) return; // not a rolling scenario
  nonSuperseded.sort((a, b) => a.horizonStart.localeCompare(b.horizonStart));
  const active = nonSuperseded[nonSuperseded.length - 1];
  const horizonSet = new Set(daysBetween(active.horizonStart, active.horizonEnd));

  const batches = asArray<BatchShape>(finalStore?.batches).filter(
    (b) => b.status !== 'cancelled',
  );
  // Carry-over (day, mealType) slots from prior sessions.
  const carryOverSlots = new Set<string>();
  for (const b of batches) {
    if (b.createdInPlanSessionId !== undefined && b.createdInPlanSessionId !== active.id) {
      for (const d of b.eatingDays ?? []) {
        if (horizonSet.has(d)) carryOverSlots.add(`${d}:${b.mealType}`);
      }
    }
  }
  // New batches in the active session — must not overlap carry-over slots.
  const collisions: string[] = [];
  for (const b of batches) {
    if (b.createdInPlanSessionId !== active.id) continue;
    for (const d of b.eatingDays ?? []) {
      const key = `${d}:${b.mealType}`;
      if (carryOverSlots.has(key)) {
        collisions.push(`${key} (new batch ${b.recipeSlug ?? b.id} collides with carry-over)`);
      }
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} batch-over-carry-over collision(s):\n  - ` +
        collisions.join('\n  - '),
    );
  }
}

/**
 * Assert the save-before-destroy guarantee for replan scenarios.
 *
 * When a user replans a future session, the store should show:
 *   - The old session with `superseded: true`.
 *   - All batches linked to the old session with `status: 'cancelled'`.
 *   - A new session (non-superseded) with its own batches.
 *
 * The "save before destroy" part of the guarantee is that the new session
 * was written BEFORE the old one was marked superseded (so a crash mid-
 * write never leaves the user with neither session). That ordering is
 * observable only via the store's write log; this helper checks the
 * final-state consequence: superseded session + cancelled batches + new
 * session exist.
 */
export function assertSaveBeforeDestroy(
  ctx: AssertionsContext,
  oldSessionId: string,
): void {
  const finalStore = ctx.finalStore as FinalStoreShape | null | undefined;
  const sessions = asArray<PlanSessionShape>(finalStore?.planSessions);
  const oldSession = sessions.find((s) => s.id === oldSessionId);
  if (!oldSession) {
    throw new Error(
      `Expected old session id=${oldSessionId} to be present in finalStore; not found.`,
    );
  }
  if (oldSession.superseded !== true) {
    throw new Error(
      `Expected old session id=${oldSessionId} to have superseded=true; got ${String(oldSession.superseded)}.`,
    );
  }
  // New session must exist (non-superseded, different id).
  const newSession = sessions.find((s) => s.id !== oldSessionId && s.superseded !== true);
  if (!newSession) {
    throw new Error(
      `Expected a non-superseded new session distinct from old id=${oldSessionId}; none found.`,
    );
  }
  // All batches linked to the old session must be cancelled.
  const batches = asArray<BatchShape>(finalStore?.batches);
  const oldBatches = batches.filter((b) => b.createdInPlanSessionId === oldSessionId);
  const notCancelled = oldBatches.filter((b) => b.status !== 'cancelled');
  if (notCancelled.length > 0) {
    throw new Error(
      `Expected all old-session batches to be cancelled; ${notCancelled.length} still ` +
        `status=planned:\n  - ` +
        notCancelled.map((b) => `${b.recipeSlug ?? b.id}`).join('\n  - '),
    );
  }
}

// ─── Dispatcher + mutation helpers (Plan 032 Waves C, G, H) ────────────────

/**
 * Assert the exact ordered sequence of dispatcher actions that fired.
 *
 * The dispatcher is the front-door router (Plan 028). Each text or
 * callback whose handling reaches the dispatcher emits a `dispatcher`
 * trace event with the chosen action. Short-circuited inputs (numeric
 * pre-filter, cancel phrase) do NOT emit an event.
 */
export function assertDispatcherActions(
  ctx: AssertionsContext,
  expected: readonly string[],
): void {
  const actual = ctx.execTrace.dispatcherActions.map((a) => a.action);
  const same = actual.length === expected.length && actual.every((a, i) => a === expected[i]);
  if (!same) {
    throw new Error(
      `Dispatcher actions mismatch:\n  expected: [${expected.join(', ')}]\n  got:      [${actual.join(', ')}]`,
    );
  }
}

/**
 * Assert the active session's mutationHistory has the expected length.
 *
 * Mutation history records every user-approved in-flow mutation (flex
 * move, recipe swap, event change, generation). Each mutation adds one
 * entry to the history on confirmation. Over-assertion of history length
 * is the cheapest way to lock the "the mutation actually landed" claim.
 */
export function assertMutationHistoryLength(
  ctx: AssertionsContext,
  expected: number,
): void {
  const session = ctx.activeSession() as
    | { mutationHistory?: unknown[] }
    | undefined;
  const actual = Array.isArray(session?.mutationHistory)
    ? session.mutationHistory.length
    : 0;
  if (actual !== expected) {
    throw new Error(
      `Expected mutationHistory.length=${expected}; got ${actual}.`,
    );
  }
}

/**
 * Assert a specific turn (by 0-based event index) did NOT reach the
 * dispatcher — i.e. was short-circuited by the cancel meta-intent or the
 * numeric pre-filter.
 *
 * The check is indirect because dispatcher emissions are not tied to turn
 * index in the trace. Instead, we compare the number of text/callback
 * events in the spec against the number of dispatcher actions: if a turn
 * was short-circuited, there are fewer dispatcher actions than routing-
 * eligible turns. The caller names the specific turn index for diagnostic
 * clarity in the failure message.
 */
export function assertNoDispatcherCallFor(
  ctx: AssertionsContext,
  turnIndex: number,
): void {
  // The simplest useful check: at least one turn in the spec was routing-
  // eligible but produced zero dispatcher actions. Scenario-level callers
  // should pair this with an assertion about the specific outcome (cancel
  // produced a "Cancelled." reply; pre-filter persisted a measurement).
  const eligibleTurns = ctx.spec.events.filter(
    (e) => e.type === 'text' || e.type === 'callback' || e.type === 'voice',
  ).length;
  const actions = ctx.execTrace.dispatcherActions.length;
  if (actions >= eligibleTurns) {
    throw new Error(
      `Expected turn ${turnIndex} to short-circuit before the dispatcher, ` +
        `but dispatcher actions (${actions}) >= routing-eligible turns (${eligibleTurns}). ` +
        `Every eligible turn appears to have reached the dispatcher.`,
    );
  }
}

// ─── Progress helpers (Plan 032 Wave D) ────────────────────────────────────

interface MeasurementShape {
  date: string;
  weightKg?: number;
  waistCm?: number;
}

interface MeasurementsStoreShape {
  measurements?: unknown;
}

/**
 * Assert a measurement matching `expected` was persisted.
 *
 * `expected.date` is required. `expected.weightKg` and `expected.waistCm`
 * are checked when provided. Useful both for direct progress scenarios
 * (Wave D) and for cross-surface scenarios (Wave I, scenario 064).
 */
export function assertMeasurementPersisted(
  ctx: AssertionsContext,
  expected: { date: string; weightKg?: number; waistCm?: number },
): void {
  const store = ctx.finalStore as MeasurementsStoreShape | null | undefined;
  const measurements = asArray<MeasurementShape>(store?.measurements);
  const match = measurements.find((m) => {
    if (m.date !== expected.date) return false;
    if (expected.weightKg !== undefined && m.weightKg !== expected.weightKg) return false;
    if (expected.waistCm !== undefined && m.waistCm !== expected.waistCm) return false;
    return true;
  });
  if (!match) {
    throw new Error(
      `Expected measurement matching ${JSON.stringify(expected)}; got: ` +
        JSON.stringify(measurements),
    );
  }
}

/**
 * Assert the weekly-report output is well-formed: contains the canonical
 * "Week of …" header and at least one mention of "kg" (weight average).
 * Catches `undefined` leaks and fully-blank reports beyond GI-03's coverage.
 */
export function assertWeeklyReportShape(ctx: AssertionsContext): void {
  const report = ctx.outputs.find(
    (o) => typeof o.text === 'string' && o.text.includes('Week of'),
  );
  if (!report) {
    throw new Error('Expected an output containing "Week of …"; none found.');
  }
  if (!/kg/.test(report.text)) {
    throw new Error(
      `Weekly report missing weight average (no "kg" found): "${report.text.slice(0, 120)}"`,
    );
  }
  if (/undefined|null/i.test(report.text)) {
    throw new Error(
      `Weekly report contains undefined/null: "${report.text.slice(0, 200)}"`,
    );
  }
}

// ─── Navigation-state helpers (Plan 032 Wave E) ────────────────────────────

interface NavigationSessionShape {
  lastRenderedView?: unknown;
  surfaceContext?: unknown;
}

/**
 * Assert the final session's `lastRenderedView` deep-equals `expected`.
 *
 * Discriminated-union variants (per `LastRenderedView` in
 * `src/telegram/navigation-state.ts`) use the same `surface`+`view`+
 * variant-specific fields shape. Comparison is order-insensitive across
 * keys but exact on every value.
 */
export function assertLastRenderedView(
  ctx: AssertionsContext,
  expected: Record<string, unknown>,
): void {
  const session = ctx.finalSession as NavigationSessionShape | null | undefined;
  const actual = session?.lastRenderedView;
  if (!actual || typeof actual !== 'object') {
    throw new Error(
      `Expected lastRenderedView=${JSON.stringify(expected)}; got ${JSON.stringify(actual)}.`,
    );
  }
  const a = actual as Record<string, unknown>;
  const sameKeys =
    Object.keys(a).length === Object.keys(expected).length &&
    Object.keys(expected).every((k) => k in a);
  const sameValues = sameKeys && Object.keys(expected).every((k) => a[k] === expected[k]);
  if (!sameValues) {
    throw new Error(
      `lastRenderedView mismatch:\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * Assert per-step `lastRenderedView` variants captured by
 * `captureStepState: true` scenarios.
 *
 * `expected[i]` is matched against `ctx.sessionAt[i]?.lastRenderedView`.
 * Use `null` to assert "no view rendered yet at this step" — useful for
 * pre-render steps. Length must match `ctx.sessionAt.length`.
 */
export function assertSessionAtVariants(
  ctx: AssertionsContext,
  expected: ReadonlyArray<Record<string, unknown> | null>,
): void {
  const snapshots = ctx.sessionAt;
  if (!snapshots) {
    throw new Error(
      'assertSessionAtVariants requires the scenario to opt into ' +
        'captureStepState (no sessionAt[] available).',
    );
  }
  if (snapshots.length !== expected.length) {
    throw new Error(
      `sessionAt length mismatch: expected ${expected.length} steps, got ${snapshots.length}.`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    const snap = snapshots[i] as NavigationSessionShape | null | undefined;
    const got = snap?.lastRenderedView;
    if (want === null) {
      if (got !== undefined && got !== null) {
        throw new Error(
          `step[${i}] expected no lastRenderedView; got ${JSON.stringify(got)}.`,
        );
      }
      continue;
    }
    if (!got || typeof got !== 'object') {
      throw new Error(
        `step[${i}] expected lastRenderedView=${JSON.stringify(want)}; got ${JSON.stringify(got)}.`,
      );
    }
    const a = got as Record<string, unknown>;
    const ok =
      Object.keys(a).length === Object.keys(want).length &&
      Object.keys(want).every((k) => a[k] === want[k]);
    if (!ok) {
      throw new Error(
        `step[${i}] lastRenderedView mismatch:\n  expected: ${JSON.stringify(want)}\n  got:      ${JSON.stringify(got)}`,
      );
    }
  }
}

// ─── Read-only rendering (used by the review CLI, not an assertion) ────────

/**
 * Build a human-readable 7-day × 2-meal grid of the active horizon.
 * Called by `npm run review` to show a "derived plan view" in probe
 * reports for planning scenarios. Returns an empty string when no active
 * context can be resolved (non-planning scenarios).
 */
export function renderDerivedPlanView(ctx: AssertionsContext): string {
  const active = resolveActiveContext(ctx);
  if (!active) return '';

  const lines: string[] = [];
  if (active.horizonDays.length > 0) {
    lines.push(`Horizon: ${active.horizonDays[0]} – ${active.horizonDays[active.horizonDays.length - 1]}`);
  }
  const sourceFor = (day: string, meal: 'lunch' | 'dinner'): string => {
    const hitsBatch = active.batches.find(
      (b) => b.mealType === meal && b.eatingDays.includes(day) && b.status !== 'cancelled',
    );
    if (hitsBatch) return `${hitsBatch.recipeSlug ?? hitsBatch.id} (batch)`;
    const hitsEvent = active.events.find((e) => e.day === day && e.mealTime === meal);
    if (hitsEvent) return 'event';
    const hitsFlex = active.flexSlots.find((f) => f.day === day && f.mealTime === meal);
    if (hitsFlex) return 'flex';
    const hitsPre = active.preCommittedSlots.find((p) => p.day === day && p.mealTime === meal);
    if (hitsPre) return 'pre-committed';
    return '—';
  };
  for (const day of active.horizonDays) {
    const dayName = new Date(day + 'T00:00:00Z').toUTCString().slice(0, 3);
    lines.push(`  ${dayName} ${day} lunch:   ${sourceFor(day, 'lunch')}`);
    lines.push(`           dinner:  ${sourceFor(day, 'dinner')}`);
  }
  return lines.join('\n');
}
