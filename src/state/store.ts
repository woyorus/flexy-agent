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
import type { WeeklyPlan } from '../models/types.js';
import type { SessionState } from './machine.js';

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
  /** Upsert a weekly plan, keyed by plan id. */
  savePlan(plan: WeeklyPlan): Promise<void>;
  /**
   * Return the most recent plan with `status in ['active', 'planning']`,
   * ordered by `weekStart` descending. A user currently editing a plan and a
   * prior active plan are both included so an in-progress plan is never
   * shadowed by the previous one.
   */
  getCurrentPlan(): Promise<WeeklyPlan | null>;
  /**
   * Return the most recent plan with `status = 'completed'`, used for
   * "last week's breakfast" fallback on the plan-week entry.
   */
  getLastCompletedPlan(): Promise<WeeklyPlan | null>;
  /**
   * Return up to `limit` completed plans ordered by `weekStart` descending.
   * Used by the plan-proposer for variety context.
   */
  getRecentCompletedPlans(limit?: number): Promise<WeeklyPlan[]>;
  /**
   * Flip every plan currently at `status = 'active'` to `'completed'`.
   * Called immediately before persisting a newly-approved plan so the week
   * transition is atomic from the user's point of view.
   */
  completeActivePlans(): Promise<void>;
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

  // ─── Weekly Plans ────────────────────────────────────────────────────────

  /**
   * Save a weekly plan. Upserts by plan ID.
   */
  async savePlan(plan: WeeklyPlan): Promise<void> {
    const { error } = await this.client
      .from('weekly_plans')
      .upsert({
        id: plan.id,
        user_id: SINGLE_USER_ID,
        week_start: plan.weekStart,
        status: plan.status,
        data: plan,
        updated_at: new Date().toISOString(),
      });

    if (error) throw new Error(`Failed to save plan: ${error.message}`);
  }

  /**
   * Get a weekly plan by ID.
   */
  async getPlan(planId: string): Promise<WeeklyPlan | null> {
    const { data, error } = await this.client
      .from('weekly_plans')
      .select('data')
      .eq('id', planId)
      .single();

    if (error) return null;
    return data?.data as WeeklyPlan;
  }

  /**
   * Get the most recent active or planning-status plan.
   */
  async getCurrentPlan(): Promise<WeeklyPlan | null> {
    const { data, error } = await this.client
      .from('weekly_plans')
      .select('data')
      .eq('user_id', SINGLE_USER_ID)
      .in('status', ['active', 'planning'])
      .order('week_start', { ascending: false })
      .limit(1)
      .single();

    if (error) return null;
    return data?.data as WeeklyPlan;
  }

  /**
   * Get the most recently completed plan (for "last week" references).
   */
  async getLastCompletedPlan(): Promise<WeeklyPlan | null> {
    const { data, error } = await this.client
      .from('weekly_plans')
      .select('data')
      .eq('user_id', SINGLE_USER_ID)
      .eq('status', 'completed')
      .order('week_start', { ascending: false })
      .limit(1)
      .single();

    if (error) return null;
    return data?.data as WeeklyPlan;
  }

  /**
   * Get the last N completed plans for variety context.
   * Used by the plan-proposer to avoid recipe repeats and rotate cuisines/protein sources.
   *
   * @param limit - How many recent plans to return (default 2)
   */
  async getRecentCompletedPlans(limit: number = 2): Promise<WeeklyPlan[]> {
    const { data, error } = await this.client
      .from('weekly_plans')
      .select('data')
      .eq('user_id', SINGLE_USER_ID)
      .eq('status', 'completed')
      .order('week_start', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data.map((row: Record<string, unknown>) => row.data as WeeklyPlan);
  }

  /**
   * Transition all active plans to completed.
   * Called when a new plan is approved — the previous week's plan is done.
   */
  async completeActivePlans(): Promise<void> {
    const { error } = await this.client
      .from('weekly_plans')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('user_id', SINGLE_USER_ID)
      .eq('status', 'active');

    if (error) {
      // Non-fatal — log but don't block the new plan
    }
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
