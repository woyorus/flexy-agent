/**
 * Shared utilities for plan-proposer and plan-flow.
 *
 * Contains functions that both the proposer (orphan fill) and the flow
 * (flex-move rebatching) need. Extracted to avoid duplication and keep
 * each module focused on its own responsibility.
 */

import type { PlanProposal, PreCommittedSlot } from '../solver/types.js';
import type { MealEvent } from '../models/types.js';
import { toLocalISODate } from './plan-proposer.js';

/**
 * Try to restore a meal-prep slot by extending an adjacent batch.
 * Returns true if successful, false if a recipe gap is needed instead.
 *
 * Plan 007: if the day is past the horizon end, it goes into overflowDays
 * instead of days. The total serving count (days + overflowDays) must not
 * exceed 3. Forward extension past horizonEnd is allowed; backward extension
 * into a prior horizon is not (D27).
 */
export function restoreMealSlot(
  proposal: PlanProposal,
  day: string,
  mealTime: 'lunch' | 'dinner',
  horizonEnd?: string,
): boolean {
  const dayDate = new Date(day + 'T00:00:00');
  const prevDay = new Date(dayDate);
  prevDay.setDate(dayDate.getDate() - 1);
  const nextDay = new Date(dayDate);
  nextDay.setDate(dayDate.getDate() + 1);

  const prevStr = toLocalISODate(prevDay);
  const nextStr = toLocalISODate(nextDay);
  const isOverflow = horizonEnd ? day > horizonEnd : false;

  for (const batch of proposal.batches) {
    if (batch.mealType !== mealTime) continue;
    // Total servings = in-horizon days + overflow days
    const totalServings = batch.days.length + (batch.overflowDays?.length ?? 0);
    if (totalServings >= 3) continue; // don't exceed 3-serving max

    // Check all days including overflow for adjacency
    const allDays = [...batch.days, ...(batch.overflowDays ?? [])];
    const lastDay = allDays[allDays.length - 1];
    const firstDay = batch.days[0]; // backward extension uses in-horizon first day only

    // Can extend forward: batch ends the day before
    if (lastDay === prevStr) {
      if (isOverflow) {
        batch.overflowDays = [...(batch.overflowDays ?? []), day];
      } else {
        batch.days.push(day);
      }
      batch.servings = batch.days.length + (batch.overflowDays?.length ?? 0);
      return true;
    }
    // Can extend backward: batch starts the day after (in-horizon only)
    if (!isOverflow && firstDay === nextStr) {
      batch.days.unshift(day);
      batch.servings = batch.days.length + (batch.overflowDays?.length ?? 0);
      return true;
    }
  }

  return false;
}

/**
 * Compute (day, mealType) pairs that have no coverage source in the proposal.
 *
 * A slot is "explained" if it's covered by any of:
 * - A batch (batch.days by mealType)
 * - A flex slot (day + mealTime)
 * - An event (day + mealTime)
 * - A pre-committed slot (day + mealTime)
 * - A pending RecipeGap (recipesToGenerate[].days by mealType)
 *
 * Returns only truly unexplained orphans — slots no source accounts for.
 * Used by both fillOrphanSlots (proposer) and the flow gate (plan-flow).
 */
export function computeUnexplainedOrphans(
  proposal: PlanProposal,
  horizonDays: string[],
  events: MealEvent[],
  preCommittedSlots: PreCommittedSlot[],
): Array<{ day: string; mealType: 'lunch' | 'dinner' }> {
  // Build the full set of (day, mealType) pairs in the horizon
  const covered = new Set<string>();

  // Batch days
  for (const batch of proposal.batches) {
    for (const day of batch.days) {
      covered.add(`${day}:${batch.mealType}`);
    }
  }

  // Flex slots
  for (const flex of proposal.flexSlots) {
    covered.add(`${flex.day}:${flex.mealTime}`);
  }

  // Events
  for (const event of events) {
    covered.add(`${event.day}:${event.mealTime}`);
  }

  // Pre-committed slots
  for (const slot of preCommittedSlots) {
    covered.add(`${slot.day}:${slot.mealTime}`);
  }

  // Recipe gaps (intentional — the proposer identified these for the gap-resolution flow)
  for (const gap of proposal.recipesToGenerate) {
    for (const day of gap.days) {
      covered.add(`${day}:${gap.mealType}`);
    }
  }

  // What's left is unexplained
  const orphans: Array<{ day: string; mealType: 'lunch' | 'dinner' }> = [];
  for (const day of horizonDays) {
    for (const mealType of ['lunch', 'dinner'] as const) {
      if (!covered.has(`${day}:${mealType}`)) {
        orphans.push({ day, mealType });
      }
    }
  }

  return orphans;
}
