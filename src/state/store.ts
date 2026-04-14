/**
 * State store — persists weekly plans and session state in Supabase.
 *
 * External state is a core architecture principle: the context window doesn't
 * carry plan data. The orchestrator holds lightweight references (plan IDs)
 * and reads full data on demand.
 *
 * Tables (create in Supabase):
 * - weekly_plans: stores WeeklyPlan objects as JSONB
 * - session_state: stores SessionState for the single user (v0.0.1)
 *
 * v0.0.1 is single-user, so session state is keyed by a fixed user ID.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
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
import type { SessionState } from './machine.js';
import { log } from '../debug/logger.js';
import { toLocalISODate } from '../plan/helpers.js';

const SINGLE_USER_ID = 'default';

/**
 * The subset of the state store contract that `BotCore` and the flows
 * actually consume. Lives in production territory (not under `src/harness/`)
 * so that the core can depend on it without ever importing test code.
 *
 * `StateStore` declares `implements StateStoreLike` below — a compile-time
 * safety net that catches drift between the class and the interface the
 * moment it happens, not when a scenario runs and produces wrong results.
 *
 * The harness's `TestStateStore` also `implements StateStoreLike`, so both
 * the real Supabase-backed class and the in-memory test double share the
 * exact same surface from the core's point of view.
 *
 * Methods included here are determined by auditing every `store.*` call
 * site in `src/telegram/core.ts`, `src/agents/plan-flow.ts`, and
 * `src/agents/recipe-flow.ts` — NOT from memory. If the core ever starts
 * calling a new `store.*` method, both this interface and every
 * implementation must be updated (`tsc` will fail loudly if either is
 * forgotten). Currently unused on the class (`saveSession`, `loadSession`,
 * `getPlan`) are intentionally omitted to keep the contract minimal.
 */
export interface StateStoreLike {
  // ─── Plan 007: rolling-horizon surface ───

  /**
   * Confirm a fresh draft. Two sequential writes:
   * (1) insert session row, (2) bulk-insert batches.
   * On error the method throws; the caller's draft stays in memory for retry.
   */
  confirmPlanSession(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
  ): Promise<PlanSession>;

  /**
   * Save-before-destroy replan (D27). Four sequential writes:
   * (1) insert NEW session, (2) bulk-insert NEW batches,
   * (3) cancel OLD session's batches, (4) mark OLD session superseded.
   * Save-before-destroy: steps 3-4 only run after 1-2 succeed.
   */
  confirmPlanSessionReplacing(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
    replacingSessionId: string,
  ): Promise<PlanSession>;

  /** Session whose horizon contains today. At most one (D15 sequential invariant). */
  getRunningPlanSession(today?: string): Promise<PlanSession | null>;

  /** Sessions with horizon_start > today, earliest first. NOT superseded. */
  getFuturePlanSessions(today?: string): Promise<PlanSession[]>;

  /** Most recent session whose horizon has fully ended. NOT superseded. */
  getLatestHistoricalPlanSession(today?: string): Promise<PlanSession | null>;

  /**
   * Up to `limit` recent sessions ordered by horizon_end DESC. NOT superseded.
   * No temporal filter — includes running, future, and historical. For variety engine.
   */
  getRecentPlanSessions(limit?: number): Promise<PlanSession[]>;

  /** Batches whose eating_days overlap [horizonStart, horizonEnd] with given statuses. */
  getBatchesOverlapping(opts: {
    horizonStart: string;
    horizonEnd: string;
    statuses: Array<'planned' | 'cancelled'>;
  }): Promise<Batch[]>;

  /** All batches created in a given plan session. */
  getBatchesByPlanSessionId(id: string): Promise<Batch[]>;

  /** Retrieve a single batch by ID. */
  getBatch(id: string): Promise<Batch | null>;

  /** Retrieve a single plan session by ID. */
  getPlanSession(id: string): Promise<PlanSession | null>;

  /**
   * Plan 033: Update specific fields on an existing PLANNED batch in place.
   * Used by the emergency ingredient swap applier. Unspecified fields are
   * not touched; a `null` value on `nameOverride` / `bodyOverride` clears
   * the column (reverts to the library recipe). `swapHistory`, when
   * provided, fully replaces the array — the caller appends first.
   *
   * Throws when the batch does not exist or its status is not `'planned'`.
   */
  updateBatch(
    batchId: string,
    fields: {
      scaledIngredients?: ScaledIngredient[];
      actualPerServing?: MacrosWithFatCarbs;
      nameOverride?: string | null;
      bodyOverride?: string | null;
      swapHistory?: SwapRecord[];
    },
  ): Promise<Batch>;

  /**
   * Plan 033: Write or clear the per-session breakfast override. Pass `null`
   * to clear the override and restore the library breakfast recipe (the
   * reset-to-original path on a breakfast target).
   *
   * Throws when the session does not exist or is superseded.
   */
  updatePlanSessionBreakfast(
    planSessionId: string,
    override: BreakfastOverride | null,
  ): Promise<PlanSession>;

  // ─── Measurements ───

  /** Upsert a measurement for the given date. */
  logMeasurement(userId: string, date: string, weightKg: number, waistCm: number | null): Promise<void>;

  /** Get today's measurement (or null). */
  getTodayMeasurement(userId: string, date: string): Promise<Measurement | null>;

  /** Get measurements for a date range (inclusive). Ordered by date ASC. */
  getMeasurements(userId: string, startDate: string, endDate: string): Promise<Measurement[]>;

  /** Get the most recent measurement for a user (for disambiguation). */
  getLatestMeasurement(userId: string): Promise<Measurement | null>;
}

/**
 * Supabase-backed state store.
 * Handles persistence of weekly plans and session state.
 */
export class StateStore implements StateStoreLike {
  private client: SupabaseClient;

  constructor() {
    this.client = createClient(config.supabase.url, config.supabase.anonKey);
  }

  // ─── Plan sessions and batches ───────────────────────────────────────────

  async confirmPlanSession(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
  ): Promise<PlanSession> {
    // Step 1: insert session row
    log.debug('STORE', `confirmPlanSession step 1: inserting session ${session.id}`);
    const { data: sessionRow, error: sessionErr } = await this.client
      .from('plan_sessions')
      .insert(toPlanSessionRow(session))
      .select()
      .single();
    if (sessionErr) throw new Error(`confirmPlanSession step 1 failed: ${sessionErr.message}`);

    // Step 2: bulk-insert batches (server-side atomic for N rows)
    if (batches.length > 0) {
      log.debug('STORE', `confirmPlanSession step 2: inserting ${batches.length} batches`);
      const { error: batchErr } = await this.client
        .from('batches')
        .insert(batches.map(toBatchRow));
      if (batchErr) throw new Error(`confirmPlanSession step 2 failed: ${batchErr.message}`);
    }

    log.debug('STORE', `confirmPlanSession complete: session ${session.id}`);
    return fromPlanSessionRow(sessionRow);
  }

  async confirmPlanSessionReplacing(
    session: DraftPlanSession,
    batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>,
    replacingSessionId: string,
  ): Promise<PlanSession> {
    // Step 1: insert NEW session
    log.debug('STORE', `confirmPlanSessionReplacing step 1: inserting new session ${session.id}`);
    const { data: sessionRow, error: sessionErr } = await this.client
      .from('plan_sessions')
      .insert(toPlanSessionRow(session))
      .select()
      .single();
    if (sessionErr) throw new Error(`confirmPlanSessionReplacing step 1 failed: ${sessionErr.message}`);

    // Step 2: bulk-insert NEW batches
    if (batches.length > 0) {
      log.debug('STORE', `confirmPlanSessionReplacing step 2: inserting ${batches.length} new batches`);
      const { error: batchErr } = await this.client
        .from('batches')
        .insert(batches.map(toBatchRow));
      if (batchErr) throw new Error(`confirmPlanSessionReplacing step 2 failed: ${batchErr.message}`);
    }

    // Step 3: cancel OLD session's batches
    log.debug('STORE', `confirmPlanSessionReplacing step 3: cancelling batches of old session ${replacingSessionId}`);
    const { error: cancelErr } = await this.client
      .from('batches')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('created_in_plan_session_id', replacingSessionId)
      .eq('status', 'planned');
    if (cancelErr) throw new Error(`confirmPlanSessionReplacing step 3 failed: ${cancelErr.message}`);

    // Step 4: mark OLD session superseded
    log.debug('STORE', `confirmPlanSessionReplacing step 4: superseding old session ${replacingSessionId}`);
    const { error: supersedeErr } = await this.client
      .from('plan_sessions')
      .update({ superseded: true, updated_at: new Date().toISOString() })
      .eq('id', replacingSessionId);
    if (supersedeErr) throw new Error(`confirmPlanSessionReplacing step 4 failed: ${supersedeErr.message}`);

    log.debug('STORE', `confirmPlanSessionReplacing complete: new ${session.id} replacing ${replacingSessionId}`);
    return fromPlanSessionRow(sessionRow);
  }

  async getPlanSession(id: string): Promise<PlanSession | null> {
    const { data, error } = await this.client
      .from('plan_sessions')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return null;
    return fromPlanSessionRow(data);
  }

  async getRunningPlanSession(today?: string): Promise<PlanSession | null> {
    const effectiveToday = today ?? toLocalISODate(new Date());
    const { data, error } = await this.client
      .from('plan_sessions')
      .select('*')
      .eq('user_id', SINGLE_USER_ID)
      .eq('superseded', false)
      .lte('horizon_start', effectiveToday)
      .gte('horizon_end', effectiveToday)
      .limit(1)
      .single();
    if (error) return null;
    return fromPlanSessionRow(data);
  }

  async getFuturePlanSessions(today?: string): Promise<PlanSession[]> {
    const effectiveToday = today ?? toLocalISODate(new Date());
    const { data, error } = await this.client
      .from('plan_sessions')
      .select('*')
      .eq('user_id', SINGLE_USER_ID)
      .eq('superseded', false)
      .gt('horizon_start', effectiveToday)
      .order('horizon_start', { ascending: true });
    if (error || !data) return [];
    return data.map(fromPlanSessionRow);
  }

  async getLatestHistoricalPlanSession(today?: string): Promise<PlanSession | null> {
    const effectiveToday = today ?? toLocalISODate(new Date());
    const { data, error } = await this.client
      .from('plan_sessions')
      .select('*')
      .eq('user_id', SINGLE_USER_ID)
      .eq('superseded', false)
      .lt('horizon_end', effectiveToday)
      .order('horizon_end', { ascending: false })
      .limit(1)
      .single();
    if (error) return null;
    return fromPlanSessionRow(data);
  }

  async getRecentPlanSessions(limit: number = 2): Promise<PlanSession[]> {
    const { data, error } = await this.client
      .from('plan_sessions')
      .select('*')
      .eq('user_id', SINGLE_USER_ID)
      .eq('superseded', false)
      .order('horizon_end', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map(fromPlanSessionRow);
  }

  async getBatchesOverlapping(opts: {
    horizonStart: string;
    horizonEnd: string;
    statuses: Array<'planned' | 'cancelled'>;
  }): Promise<Batch[]> {
    // Build date array for the horizon to use with Postgres overlap operator
    const horizonDays = buildDateRange(opts.horizonStart, opts.horizonEnd);
    const { data, error } = await this.client
      .from('batches')
      .select('*')
      .eq('user_id', SINGLE_USER_ID)
      .in('status', opts.statuses)
      .overlaps('eating_days', horizonDays);
    if (error || !data) return [];
    return data.map(fromBatchRow);
  }

  async getBatchesByPlanSessionId(id: string): Promise<Batch[]> {
    const { data, error } = await this.client
      .from('batches')
      .select('*')
      .eq('created_in_plan_session_id', id);
    if (error || !data) return [];
    return data.map(fromBatchRow);
  }

  async getBatch(id: string): Promise<Batch | null> {
    const { data, error } = await this.client
      .from('batches')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return null;
    return fromBatchRow(data);
  }

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
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (fields.scaledIngredients !== undefined) patch.scaled_ingredients = fields.scaledIngredients;
    if (fields.actualPerServing !== undefined) patch.actual_per_serving = fields.actualPerServing;
    if (fields.nameOverride !== undefined) patch.name_override = fields.nameOverride;
    if (fields.bodyOverride !== undefined) patch.body_override = fields.bodyOverride;
    if (fields.swapHistory !== undefined) patch.swap_history = fields.swapHistory;

    const { data, error } = await this.client
      .from('batches')
      .update(patch)
      .eq('id', batchId)
      .eq('status', 'planned')
      .select()
      .single();
    if (error || !data) {
      throw new Error(
        `updateBatch(${batchId}) failed: ${error?.message ?? 'no matching planned batch'}`,
      );
    }
    return fromBatchRow(data);
  }

  async updatePlanSessionBreakfast(
    planSessionId: string,
    override: BreakfastOverride | null,
  ): Promise<PlanSession> {
    const { data, error } = await this.client
      .from('plan_sessions')
      .update({ breakfast_override: override, updated_at: new Date().toISOString() })
      .eq('id', planSessionId)
      .eq('superseded', false)
      .select()
      .single();
    if (error || !data) {
      throw new Error(
        `updatePlanSessionBreakfast(${planSessionId}) failed: ${error?.message ?? 'no matching active session'}`,
      );
    }
    return fromPlanSessionRow(data);
  }

  // ─── Measurements ───────────────────────────────────────────────────────

  async logMeasurement(userId: string, date: string, weightKg: number, waistCm: number | null): Promise<void> {
    const { error } = await this.client
      .from('measurements')
      .upsert(toMeasurementRow(userId, date, weightKg, waistCm), { onConflict: 'user_id,date' });
    if (error) throw new Error(`logMeasurement failed: ${error.message}`);
  }

  async getTodayMeasurement(userId: string, date: string): Promise<Measurement | null> {
    const { data, error } = await this.client
      .from('measurements')
      .select('*')
      .eq('user_id', userId)
      .eq('date', date)
      .single();
    if (error) return null;
    return fromMeasurementRow(data);
  }

  async getMeasurements(userId: string, startDate: string, endDate: string): Promise<Measurement[]> {
    const { data, error } = await this.client
      .from('measurements')
      .select('*')
      .eq('user_id', userId)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    if (error || !data) return [];
    return data.map(fromMeasurementRow);
  }

  async getLatestMeasurement(userId: string): Promise<Measurement | null> {
    const { data, error } = await this.client
      .from('measurements')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .limit(1)
      .single();
    if (error) return null;
    return fromMeasurementRow(data);
  }

  // ─── Session State ───────────────────────────────────────────────────────

  /**
   * Save the current session state.
   * v0.0.1 has a single user, so this is a simple key-value upsert.
   */
  async saveSession(state: SessionState): Promise<void> {
    const { error } = await this.client
      .from('session_state')
      .upsert({
        user_id: SINGLE_USER_ID,
        data: state,
        updated_at: new Date().toISOString(),
      });

    if (error) throw new Error(`Failed to save session: ${error.message}`);
  }

  /**
   * Load the current session state. Returns null if no session exists.
   */
  async loadSession(): Promise<SessionState | null> {
    const { data, error } = await this.client
      .from('session_state')
      .select('data')
      .eq('user_id', SINGLE_USER_ID)
      .single();

    if (error) return null;
    return data?.data as SessionState;
  }
}

// ─── Row mapping helpers (DB snake_case ↔ TypeScript camelCase) ─────────────

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPlanSessionRow(session: DraftPlanSession): Record<string, any> {
  return {
    id: session.id,
    user_id: SINGLE_USER_ID,
    horizon_start: session.horizonStart,
    horizon_end: session.horizonEnd,
    breakfast: session.breakfast,
    treat_budget_calories: session.treatBudgetCalories,
    flex_slots: session.flexSlots,
    events: session.events,
    mutation_history: session.mutationHistory ?? [],
    // breakfast_override is never set on drafts (Plan 033) — the Omit in
    // DraftPlanSession enforces this at the type level.
    breakfast_override: null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromPlanSessionRow(row: any): PlanSession {
  const breakfastOverride = row.breakfast_override ?? undefined;
  const session: PlanSession = {
    id: row.id,
    horizonStart: row.horizon_start,
    horizonEnd: row.horizon_end,
    breakfast: row.breakfast,
    treatBudgetCalories: row.treat_budget_calories,
    flexSlots: row.flex_slots ?? [],
    events: row.events ?? [],
    mutationHistory: row.mutation_history ?? [],
    confirmedAt: row.confirmed_at,
    superseded: row.superseded,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (breakfastOverride !== undefined && breakfastOverride !== null) {
    session.breakfastOverride = breakfastOverride;
  }
  return session;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBatchRow(batch: Omit<Batch, 'createdAt' | 'updatedAt'>): Record<string, any> {
  return {
    id: batch.id,
    user_id: SINGLE_USER_ID,
    recipe_slug: batch.recipeSlug,
    meal_type: batch.mealType,
    eating_days: batch.eatingDays,
    servings: batch.servings,
    target_per_serving: batch.targetPerServing,
    actual_per_serving: batch.actualPerServing,
    scaled_ingredients: batch.scaledIngredients,
    name_override: batch.nameOverride ?? null,
    body_override: batch.bodyOverride ?? null,
    swap_history: batch.swapHistory ?? [],
    status: batch.status,
    created_in_plan_session_id: batch.createdInPlanSessionId,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMeasurementRow(userId: string, date: string, weightKg: number, waistCm: number | null): Record<string, any> {
  return {
    id: crypto.randomUUID(),
    user_id: userId,
    date,
    weight_kg: weightKg,
    waist_cm: waistCm,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromMeasurementRow(row: any): Measurement {
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    weightKg: Number(row.weight_kg),
    waistCm: row.waist_cm != null ? Number(row.waist_cm) : null,
    createdAt: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromBatchRow(row: any): Batch {
  const batch: Batch = {
    id: row.id,
    recipeSlug: row.recipe_slug,
    mealType: row.meal_type,
    eatingDays: row.eating_days,
    servings: row.servings,
    targetPerServing: row.target_per_serving,
    actualPerServing: row.actual_per_serving,
    scaledIngredients: (row.scaled_ingredients ?? []).map((i: any) => ({
      ...i,
      role: i.role ?? 'base',  // 'base' is the safest default for old rows without role
    })),
    status: row.status,
    createdInPlanSessionId: row.created_in_plan_session_id,
  };
  // Plan 033: only materialize override fields when the row carries them,
  // so the runtime type stays exactly `Batch` (no undefined keys leaking
  // into snapshot serialization or equality checks).
  if (row.name_override != null) batch.nameOverride = row.name_override;
  if (row.body_override != null) batch.bodyOverride = row.body_override;
  const swapHistory = row.swap_history ?? [];
  if (Array.isArray(swapHistory) && swapHistory.length > 0) {
    batch.swapHistory = swapHistory;
  }
  return batch;
}
