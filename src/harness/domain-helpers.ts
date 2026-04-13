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
  supersededBy?: unknown;
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

  // Post-confirmation path: use the active persisted session (not
  // superseded). `supersededBy` being null/undefined means still active.
  const sessions = asArray<PlanSessionShape>(finalStore?.planSessions);
  const active = sessions.find(
    (s) => s.supersededBy === null || s.supersededBy === undefined,
  );
  if (active) {
    const horizonDays = daysBetween(active.horizonStart, active.horizonEnd);
    // Only batches created in the active session count — any stale batch
    // linked to a superseded session is carryover.
    const batchesForActive = activeBatches.filter(
      (b) => b.createdInPlanSessionId === active.id || b.createdInPlanSessionId === undefined,
    );
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
