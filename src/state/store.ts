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
 * Supabase-backed state store.
 * Handles persistence of weekly plans and session state.
 */
export class StateStore {
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
