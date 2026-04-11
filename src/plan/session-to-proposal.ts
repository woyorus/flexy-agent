/**
 * Session-to-proposal adapter — Plan 026.
 *
 * Converts a persisted `PlanSession + Batch[]` into the in-memory
 * `PlanProposal` shape the re-proposer consumes, splitting the plan at the
 * (date, mealType) level using server-local wall-clock cutoffs. The split
 * boundary determines which slots are "past" (frozen, preserved verbatim) and
 * which are "active" (sent to the re-proposer for mutation).
 *
 * This file is pure — no store calls, no LLM calls, no clock reads beyond
 * the `now: Date` passed in by the caller. All downstream logic (re-proposer
 * invocation, write via confirmPlanSessionReplacing) is wired up by the
 * caller (Plan D). Plan 026 only ships the adapter and its unit tests.
 *
 * Design doc: docs/design-docs/proposals/003-freeform-conversation-layer.md
 */

import type { Batch } from '../models/types.js';
import type { ProposedBatch } from '../solver/types.js';
import { toLocalISODate } from './helpers.js';

/**
 * Server-local hour (24h) after which "today's lunch" is considered past.
 * 15:00 means lunch is active until 2:59pm and past from 3:00pm onward.
 * Chosen per proposal 003 as the pragmatic default for the single-user v0.0.5
 * simplification; can be revisited when multi-user timezone support lands.
 */
export const LUNCH_DONE_CUTOFF_HOUR = 15;

/**
 * Server-local hour (24h) after which "today's dinner" is considered past.
 * 21:00 means dinner is active until 8:59pm and past from 9:00pm onward.
 */
export const DINNER_DONE_CUTOFF_HOUR = 21;

/**
 * Classify a single slot as past or active relative to `now`.
 *
 * A slot is "past" when any of:
 *   (a) its date is strictly before today's local date;
 *   (b) it's today's lunch and now >= 15:00 local;
 *   (c) it's today's dinner and now >= 21:00 local.
 *
 * Otherwise it's "active" and the re-proposer is allowed to see and mutate it.
 *
 * @param day - ISO date of the slot
 * @param mealType - 'lunch' or 'dinner' (breakfast is never part of a batch)
 * @param now - Current wall clock; read only for hour/ISO date, never Date.now()
 */
export function classifySlot(day: string, mealType: 'lunch' | 'dinner', now: Date): 'past' | 'active' {
  const today = toLocalISODate(now);
  if (day < today) return 'past';
  if (day > today) return 'active';
  // day === today: use meal cutoff.
  const hour = now.getHours();
  if (mealType === 'lunch') return hour >= LUNCH_DONE_CUTOFF_HOUR ? 'past' : 'active';
  return hour >= DINNER_DONE_CUTOFF_HOUR ? 'past' : 'active';
}

/**
 * Result of classifying a single batch against the current wall clock.
 *
 * - `past-only`: every eating day is strictly past. The batch is preserved
 *   verbatim and flows into the write payload unchanged.
 * - `active-only`: every eating day is strictly active. The batch is rendered
 *   as a `ProposedBatch` for the re-proposer to see and potentially mutate.
 * - `spanning`: some eating days are past, others active. Task 9 splits these
 *   into a past half (Batch) and an active half (ProposedBatch).
 */
export type SplitBatchResult =
  | { kind: 'past-only'; pastBatch: Batch }
  | { kind: 'active-only'; activeBatch: ProposedBatch }
  | { kind: 'spanning'; pastBatch: Batch; activeBatch: ProposedBatch };

/**
 * Split a single persisted batch across the (date, mealType) cutoff.
 *
 * Determines whether the batch is past-only, active-only, or spanning, and
 * returns the pieces needed to reconstruct the plan after the re-proposer
 * runs on the active portion. Pure — never reads real clocks or recipes.
 *
 * @param batch - A persisted Batch loaded from the store
 * @param now - Current wall clock
 */
export function splitBatchAtCutoffs(batch: Batch, now: Date): SplitBatchResult {
  const pastDays: string[] = [];
  const activeDays: string[] = [];
  for (const day of batch.eatingDays) {
    if (classifySlot(day, batch.mealType, now) === 'past') {
      pastDays.push(day);
    } else {
      activeDays.push(day);
    }
  }

  if (pastDays.length === 0) {
    return {
      kind: 'active-only',
      activeBatch: {
        recipeSlug: batch.recipeSlug,
        // Recipe display name isn't stored on Batch — caller resolves it later
        // if needed. For now use the slug as a placeholder; downstream code
        // resolves via RecipeDatabase when it prints anything.
        recipeName: batch.recipeSlug,
        mealType: batch.mealType,
        days: activeDays,
        servings: activeDays.length,
        overflowDays: undefined,
      },
    };
  }

  if (activeDays.length === 0) {
    return { kind: 'past-only', pastBatch: batch };
  }

  // Spanning — Task 9 fills this in.
  throw new Error('splitBatchAtCutoffs: spanning batches not implemented yet (Task 9)');
}
