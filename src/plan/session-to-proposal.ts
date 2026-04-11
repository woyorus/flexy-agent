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

import { randomUUID } from 'node:crypto';
import type { Batch, FlexSlot, MealEvent, PlanSession } from '../models/types.js';
import type { PlanProposal, ProposedBatch } from '../solver/types.js';
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

  // Spanning: past days keep their original scaled totals scaled down
  // proportionally, and get a fresh id (the past half becomes a new row in
  // the next session). Active days become a ProposedBatch for the re-proposer.
  const pastBatch: Batch = {
    id: randomUUID(),
    recipeSlug: batch.recipeSlug,
    mealType: batch.mealType,
    eatingDays: pastDays,
    servings: pastDays.length,
    targetPerServing: batch.targetPerServing,
    actualPerServing: batch.actualPerServing,
    scaledIngredients: scaleIngredientTotals(batch.scaledIngredients, pastDays.length, batch.servings),
    status: 'planned',
    createdInPlanSessionId: batch.createdInPlanSessionId,
  };

  const activeBatch: ProposedBatch = {
    recipeSlug: batch.recipeSlug,
    recipeName: batch.recipeSlug,
    mealType: batch.mealType,
    days: activeDays,
    servings: activeDays.length,
    overflowDays: undefined,
  };

  return { kind: 'spanning', pastBatch, activeBatch };
}

/**
 * Proportionally scale a batch's ingredient amounts for a reduced serving count.
 *
 * `scaledIngredients[i].totalForBatch` was computed at plan time as
 * `recipe.ingredients[i].amount * originalServings` (see
 * `src/agents/plan-flow.ts:911`). When we split a batch, each half gets a
 * proportional share of the totals. Per-serving `amount` / `unit` stay
 * unchanged.
 */
function scaleIngredientTotals<T extends { amount: number; totalForBatch: number }>(
  items: T[],
  newServings: number,
  originalServings: number,
): T[] {
  if (originalServings === 0) return items;
  const ratio = newServings / originalServings;
  return items.map((it) => ({
    ...it,
    totalForBatch: Math.round(it.totalForBatch * ratio),
  }));
}

/**
 * Forward-adapter result. `activeProposal` is the shape the re-proposer accepts;
 * `preservedPastBatches` are the batches (and split halves of spanning batches)
 * that belong entirely to past slots and must be written unchanged into the
 * new session at round-trip time. `preservedPastFlexSlots` and
 * `preservedPastEvents` are the flex slots and meal events whose `day`+`mealTime`
 * classify as past at `now` — the re-proposer never sees them but they must
 * round-trip into the rewritten session so the user's historical record is not
 * erased on every mutate. `nearFutureDays` captures the 2-day soft-locked
 * window for the re-proposer's post-confirmation safety rule.
 */
export interface PostConfirmationProposal {
  activeProposal: PlanProposal;
  preservedPastBatches: Batch[];
  preservedPastFlexSlots: FlexSlot[];
  preservedPastEvents: MealEvent[];
  horizonDays: string[];
  nearFutureDays: string[];
}

/**
 * Expand an ISO horizon (start + end) into the 7 ISO day strings it covers.
 */
function expandHorizonDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d <= e) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * The 2-day near-future soft-lock window for post-confirmation safety.
 * Returns today + tomorrow as ISO dates, intersected with the horizon so we
 * never produce days outside the session range.
 */
function computeNearFutureDays(now: Date, horizonDays: string[]): string[] {
  const today = toLocalISODate(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = toLocalISODate(tomorrow);
  return [today, tomorrowISO].filter((d) => horizonDays.includes(d));
}

/**
 * Convert a persisted PlanSession + its Batch[] into the re-proposer's
 * in-memory PlanProposal shape, splitting at the (date, mealType) level.
 *
 * The result's `activeProposal` contains only batches, flex slots, and events
 * that fall on active slots — past slots are frozen and never shown to the
 * re-proposer. The `preservedPastBatches` array contains Batches that must
 * flow through the round-trip unchanged (pure-past batches) or with
 * proportionally split ingredient totals (past halves of spanning batches).
 *
 * @param session - The confirmed plan session loaded from the store
 * @param batches - All batches whose createdInPlanSessionId === session.id
 *                  (i.e., the result of store.getBatchesByPlanSessionId)
 * @param now - Current wall clock
 */
export function sessionToPostConfirmationProposal(
  session: PlanSession,
  batches: Batch[],
  now: Date,
): PostConfirmationProposal {
  const horizonDays = expandHorizonDays(session.horizonStart, session.horizonEnd);
  const preservedPastBatches: Batch[] = [];
  const activeBatches: ProposedBatch[] = [];

  for (const b of batches) {
    // Skip cancelled batches entirely — they don't belong to the live plan.
    if (b.status !== 'planned') continue;

    const split = splitBatchAtCutoffs(b, now);
    if (split.kind === 'past-only') {
      preservedPastBatches.push(split.pastBatch);
    } else if (split.kind === 'active-only') {
      activeBatches.push(split.activeBatch);
    } else {
      preservedPastBatches.push(split.pastBatch);
      activeBatches.push(split.activeBatch);
    }
  }

  // Sort active batches by first active day for stable output (scenario diffs).
  activeBatches.sort((a, b) => {
    const da = a.days[0] ?? '';
    const db = b.days[0] ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a.mealType < b.mealType ? -1 : 1;
  });

  // Flex slots and events: partition by classification at `now`. Active ones
  // go to `activeProposal` (the re-proposer can see and rearrange them);
  // past ones go to `preservedPast*` (frozen historical record that the
  // round-trip splices back into the rewritten session). Dropping past ones
  // on the floor would erase the user's record of "Sunday dinner was a flex
  // slot" or "I ate out Monday" on every mutate — exactly the kind of silent
  // data loss the save-before-destroy model exists to prevent.
  const activeFlexSlots: FlexSlot[] = [];
  const preservedPastFlexSlots: FlexSlot[] = [];
  for (const fs of session.flexSlots) {
    if (classifySlot(fs.day, fs.mealTime, now) === 'active') {
      activeFlexSlots.push(fs);
    } else {
      preservedPastFlexSlots.push(fs);
    }
  }

  const activeEvents: MealEvent[] = [];
  const preservedPastEvents: MealEvent[] = [];
  for (const ev of session.events) {
    if (classifySlot(ev.day, ev.mealTime, now) === 'active') {
      activeEvents.push(ev);
    } else {
      preservedPastEvents.push(ev);
    }
  }

  const activeProposal: PlanProposal = {
    batches: activeBatches,
    flexSlots: activeFlexSlots,
    events: activeEvents,
    recipesToGenerate: [],
  };

  return {
    activeProposal,
    preservedPastBatches,
    preservedPastFlexSlots,
    preservedPastEvents,
    horizonDays,
    nearFutureDays: computeNearFutureDays(now, horizonDays),
  };
}
