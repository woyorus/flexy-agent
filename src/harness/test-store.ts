/**
 * In-memory `StateStoreLike` implementation for the scenario harness.
 *
 * Acts as a drop-in replacement for the Supabase-backed `StateStore` during
 * test runs. Production code (`BotCore`) depends on `StateStoreLike`, so the
 * substitution is type-safe with zero production changes.
 *
 * The whole point of a test double at the persistence layer is that the
 * harness can assert on the final store state — not just captured Telegram
 * output. The plan-approval flow calls `completeActivePlans()` and
 * `savePlan()` as load-bearing side effects; a bug that produces a correct
 * transcript but skips persistence would slip past a transcript-only check.
 * `snapshot()` exposes the full internal state for that kind of assertion.
 *
 * ## Filter semantics must match production exactly
 *
 * Every query method here mirrors the equivalent `StateStore` SQL predicate
 * verbatim, with a cross-reference comment pointing at the production line
 * it shadows. Any drift (e.g. this class only tracks `'active'` while
 * production filters on `['active', 'planning']`) would silently invalidate
 * scenarios touching in-progress plans. Code review catches the drift via
 * the comments; the unit test suite in `test-store.test.ts` catches it via
 * behavioral assertions against known seed data.
 */

import type {
  PlanSession,
  DraftPlanSession,
  Batch,
  Measurement,
  ScaledIngredient,
  MacrosWithFatCarbs,
  SwapRecord,
  BreakfastOverride,
} from '../models/types.js';
import type { SessionState } from '../state/machine.js';
import type { StateStoreLike } from '../state/store.js';

export interface TestStateStoreSeed {
  /** Pre-existing session slot. v0.0.1 has one session per single user. */
  session?: SessionState | null;
  /** Plan sessions for rolling-horizon scenarios. */
  planSessions?: PlanSession[];
  /** Batches for rolling-horizon scenarios. */
  batches?: Batch[];
  /** Pre-existing measurements for progress scenarios. */
  measurements?: Measurement[];
}

export interface TestStateStoreSnapshot {
  /** Current session slot, or null if never written. */
  session: SessionState | null;
  /** All plan sessions in insertion order. */
  planSessions: PlanSession[];
  /** All batches in insertion order. */
  batches: Batch[];
  /** All measurements, included only when non-empty to keep diffs clean. */
  measurements?: Measurement[];
}

/**
 * In-memory state store for scenario replay. `implements StateStoreLike`
 * makes TypeScript enforce signature parity with production.
 */
export class TestStateStore implements StateStoreLike {
  private session: SessionState | null;
  private readonly planSessionsById: Map<string, PlanSession>;
  private readonly batchesById: Map<string, Batch>;
  private measurements: Measurement[];
  /** Injected "today" for temporal queries. Defaults to real today if not set. */
  private todayOverride: string | null = null;

  constructor(seed: TestStateStoreSeed = {}) {
    this.session = seed.session ? cloneDeep(seed.session) : null;
    this.planSessionsById = new Map();
    if (seed.planSessions) {
      for (const ps of seed.planSessions) {
        this.planSessionsById.set(ps.id, cloneDeep(ps));
      }
    }
    this.batchesById = new Map();
    if (seed.batches) {
      for (const b of seed.batches) {
        this.batchesById.set(b.id, cloneDeep(b));
      }
    }
    this.measurements = seed.measurements ? seed.measurements.map(cloneDeep) : [];
  }

  /** Override "today" for temporal queries in tests. */
  setToday(isoDate: string): void {
    this.todayOverride = isoDate;
  }

  private getToday(): string {
    return this.todayOverride ?? new Date().toISOString().slice(0, 10);
  }

  // ─── Plan sessions and batches ──────────────────────────────────────────

  /**
   * Confirm a fresh draft. Two-step in-memory sequence matching
   * StateStore.confirmPlanSession at src/state/store.ts.
   */
  async confirmPlanSession(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
  ): Promise<PlanSession> {
    const now = new Date().toISOString();
    // Step 1: insert session. `mutationHistory` falls through from the draft,
    // or defaults to [] when the draft leaves it unset. Mirrors the production
    // `toPlanSessionRow` default at src/state/store.ts.
    const persisted: PlanSession = {
      ...cloneDeep(session),
      mutationHistory: session.mutationHistory ?? [],
      confirmedAt: now,
      superseded: false,
      createdAt: now,
      updatedAt: now,
    };
    this.planSessionsById.set(persisted.id, cloneDeep(persisted));

    // Step 2: insert batches
    for (const b of batches) {
      const full: Batch = { ...cloneDeep(b) as Batch };
      this.batchesById.set(full.id, full);
    }

    return cloneDeep(persisted);
  }

  /**
   * Save-before-destroy replan. Four-step in-memory sequence matching
   * StateStore.confirmPlanSessionReplacing at src/state/store.ts.
   */
  async confirmPlanSessionReplacing(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
    replacingSessionId: string,
  ): Promise<PlanSession> {
    const now = new Date().toISOString();

    // Step 1: insert NEW session. `mutationHistory` falls through from the
    // draft, or defaults to [] when the draft leaves it unset.
    const persisted: PlanSession = {
      ...cloneDeep(session),
      mutationHistory: session.mutationHistory ?? [],
      confirmedAt: now,
      superseded: false,
      createdAt: now,
      updatedAt: now,
    };
    this.planSessionsById.set(persisted.id, cloneDeep(persisted));

    // Step 2: insert NEW batches
    for (const b of batches) {
      const full: Batch = { ...cloneDeep(b) as Batch };
      this.batchesById.set(full.id, full);
    }

    // Step 3: cancel OLD session's batches
    for (const b of this.batchesById.values()) {
      if (b.createdInPlanSessionId === replacingSessionId && b.status === 'planned') {
        b.status = 'cancelled';
      }
    }

    // Step 4: mark OLD session superseded
    const oldSession = this.planSessionsById.get(replacingSessionId);
    if (oldSession) {
      oldSession.superseded = true;
      oldSession.updatedAt = now;
    }

    return cloneDeep(persisted);
  }

  async getPlanSession(id: string): Promise<PlanSession | null> {
    const ps = this.planSessionsById.get(id);
    return ps ? cloneDeep(ps) : null;
  }

  /**
   * Session whose horizon contains today. At most one by D15 invariant.
   * Mirrors StateStore.getRunningPlanSession.
   */
  async getRunningPlanSession(today?: string): Promise<PlanSession | null> {
    const effectiveToday = today ?? this.getToday();
    const candidates = [...this.planSessionsById.values()].filter(
      (ps) => !ps.superseded && ps.horizonStart <= effectiveToday && ps.horizonEnd >= effectiveToday,
    );
    return candidates.length > 0 ? cloneDeep(candidates[0]!) : null;
  }

  /**
   * Sessions with horizon_start > today, earliest first. NOT superseded.
   * Mirrors StateStore.getFuturePlanSessions.
   */
  async getFuturePlanSessions(today?: string): Promise<PlanSession[]> {
    const effectiveToday = today ?? this.getToday();
    const candidates = [...this.planSessionsById.values()].filter(
      (ps) => !ps.superseded && ps.horizonStart > effectiveToday,
    );
    candidates.sort((a, b) => (a.horizonStart < b.horizonStart ? -1 : a.horizonStart > b.horizonStart ? 1 : 0));
    return candidates.map(cloneDeep);
  }

  /**
   * Most recent session whose horizon has fully ended. NOT superseded.
   * Mirrors StateStore.getLatestHistoricalPlanSession.
   */
  async getLatestHistoricalPlanSession(today?: string): Promise<PlanSession | null> {
    const effectiveToday = today ?? this.getToday();
    const candidates = [...this.planSessionsById.values()].filter(
      (ps) => !ps.superseded && ps.horizonEnd < effectiveToday,
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.horizonEnd < b.horizonEnd ? 1 : a.horizonEnd > b.horizonEnd ? -1 : 0));
    return cloneDeep(candidates[0]!);
  }

  /**
   * Up to `limit` recent sessions ordered by horizon_end DESC. NOT superseded.
   * No temporal filter. Mirrors StateStore.getRecentPlanSessions.
   */
  async getRecentPlanSessions(limit: number = 2): Promise<PlanSession[]> {
    const candidates = [...this.planSessionsById.values()].filter((ps) => !ps.superseded);
    candidates.sort((a, b) => (a.horizonEnd < b.horizonEnd ? 1 : a.horizonEnd > b.horizonEnd ? -1 : 0));
    return candidates.slice(0, limit).map(cloneDeep);
  }

  /**
   * Batches whose eating_days overlap [horizonStart, horizonEnd] with given statuses.
   * Mirrors StateStore.getBatchesOverlapping using array overlap semantics.
   */
  async getBatchesOverlapping(opts: {
    horizonStart: string;
    horizonEnd: string;
    statuses: Array<'planned' | 'cancelled'>;
  }): Promise<Batch[]> {
    const horizonDays = buildDateRange(opts.horizonStart, opts.horizonEnd);
    const result: Batch[] = [];
    for (const b of this.batchesById.values()) {
      if (!opts.statuses.includes(b.status)) continue;
      // Array overlap: any eating day in the horizon range
      const overlaps = b.eatingDays.some((d) => horizonDays.includes(d));
      if (overlaps) result.push(cloneDeep(b));
    }
    return result;
  }

  async getBatchesByPlanSessionId(id: string): Promise<Batch[]> {
    const result: Batch[] = [];
    for (const b of this.batchesById.values()) {
      if (b.createdInPlanSessionId === id) result.push(cloneDeep(b));
    }
    return result;
  }

  async getBatch(id: string): Promise<Batch | null> {
    const b = this.batchesById.get(id);
    return b ? cloneDeep(b) : null;
  }

  /**
   * Plan 033: In-memory mirror of StateStore.updateBatch. Mutates the stored
   * batch in place; throws when the batch is missing or not 'planned' so a
   * bug in the applier fails loudly in the harness rather than silently
   * no-opping.
   */
  async updateBatch(
    batchId: string,
    fields: {
      scaledIngredients?: ScaledIngredient[];
      actualPerServing?: MacrosWithFatCarbs;
      nameOverride?: string | null;
      bodyOverride?: string | null;
      swapHistory?: SwapRecord[];
    },
  ): Promise<Batch> {
    const existing = this.batchesById.get(batchId);
    if (!existing) throw new Error(`updateBatch(${batchId}) failed: batch not found`);
    if (existing.status !== 'planned') {
      throw new Error(`updateBatch(${batchId}) failed: status is ${existing.status}`);
    }
    const updated: Batch = { ...existing };
    if (fields.scaledIngredients !== undefined) {
      updated.scaledIngredients = cloneDeep(fields.scaledIngredients);
    }
    if (fields.actualPerServing !== undefined) {
      updated.actualPerServing = cloneDeep(fields.actualPerServing);
    }
    if (fields.nameOverride !== undefined) {
      if (fields.nameOverride === null) delete updated.nameOverride;
      else updated.nameOverride = fields.nameOverride;
    }
    if (fields.bodyOverride !== undefined) {
      if (fields.bodyOverride === null) delete updated.bodyOverride;
      else updated.bodyOverride = fields.bodyOverride;
    }
    if (fields.swapHistory !== undefined) {
      if (fields.swapHistory.length === 0) delete updated.swapHistory;
      else updated.swapHistory = cloneDeep(fields.swapHistory);
    }
    this.batchesById.set(batchId, updated);
    return cloneDeep(updated);
  }

  /**
   * Plan 033: In-memory mirror of StateStore.updatePlanSessionBreakfast. Pass
   * `null` to clear the override (reset-to-original for a breakfast target).
   */
  async updatePlanSessionBreakfast(
    planSessionId: string,
    override: BreakfastOverride | null,
  ): Promise<PlanSession> {
    const existing = this.planSessionsById.get(planSessionId);
    if (!existing) {
      throw new Error(`updatePlanSessionBreakfast(${planSessionId}) failed: session not found`);
    }
    if (existing.superseded) {
      throw new Error(`updatePlanSessionBreakfast(${planSessionId}) failed: session is superseded`);
    }
    const updated: PlanSession = { ...existing, updatedAt: new Date().toISOString() };
    if (override === null) {
      delete updated.breakfastOverride;
    } else {
      updated.breakfastOverride = cloneDeep(override);
    }
    this.planSessionsById.set(planSessionId, updated);
    return cloneDeep(updated);
  }

  // ─── Measurements ─────────────────────────────────────────────────────

  async logMeasurement(userId: string, date: string, weightKg: number, waistCm: number | null): Promise<void> {
    const idx = this.measurements.findIndex((m) => m.userId === userId && m.date === date);
    const entry: Measurement = {
      id: idx >= 0 ? this.measurements[idx]!.id : crypto.randomUUID(),
      userId,
      date,
      weightKg,
      waistCm,
      createdAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      this.measurements[idx] = entry;
    } else {
      this.measurements.push(entry);
    }
  }

  async getTodayMeasurement(userId: string, date: string): Promise<Measurement | null> {
    return this.measurements.find((m) => m.userId === userId && m.date === date) ?? null;
  }

  async getMeasurements(userId: string, startDate: string, endDate: string): Promise<Measurement[]> {
    return this.measurements
      .filter((m) => m.userId === userId && m.date >= startDate && m.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getLatestMeasurement(userId: string): Promise<Measurement | null> {
    const userMeasurements = this.measurements
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.date.localeCompare(a.date));
    return userMeasurements.length > 0 ? userMeasurements[0]! : null;
  }

  // ─── Harness introspection ─────────────────────────────────────────────

  /**
   * Return the full internal state for assertions. The harness runner calls
   * this at the end of each scenario and asserts the result matches the
   * recorded `expected.finalStore`. Deep-cloned so test code can hold onto
   * the snapshot without observing subsequent mutations.
   *
   * `currentPlan` re-runs `getCurrentPlan()`'s filter so assertions against
   * the snapshot match production query behavior exactly.
   */
  snapshot(): TestStateStoreSnapshot {
    return {
      session: this.session ? cloneDeep(this.session) : null,
      planSessions: [...this.planSessionsById.values()].map(cloneDeep),
      batches: [...this.batchesById.values()].map(cloneDeep),
      ...(this.measurements.length > 0 ? { measurements: this.measurements.map(cloneDeep) } : {}),
    };
  }
}

/** Build an array of ISO date strings from start to end inclusive. */
function buildDateRange(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  while (d <= endD) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * Structured deep clone. Uses Node's built-in `structuredClone` (available
 * on Node 17+), which handles `Date`, `Map`, nested objects, and arrays.
 * Keeps stored data immune to caller mutations without pulling in lodash.
 */
function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}
