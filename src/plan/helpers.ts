/**
 * Plan lifecycle detection and data helpers.
 *
 * Shared substrate for v0.0.4 features (Next Action, cook view, shopping list,
 * week overview). All downstream screens depend on these to decide what to show.
 *
 * Two categories:
 * 1. **Lifecycle detection** — async, needs session + store to determine where
 *    the user is relative to their plan (no plan, planning, active early/mid/ending).
 * 2. **Plan data helpers** — pure functions operating on `Batch[]` + a `today`
 *    string. No store access needed; callers pass raw batches from the store.
 *
 * `toLocalISODate` is also re-exported from here as the canonical location.
 * `src/agents/plan-proposer.ts` re-exports it for backward compatibility.
 */

import type { Batch, PlanSession } from '../models/types.js';
import type { StateStoreLike } from '../state/store.js';
import type { BotCoreSession } from '../telegram/core.js';

// ─── toLocalISODate (canonical location) ────────────────────────────────────

/**
 * Format a `Date` as a local ISO date string (YYYY-MM-DD).
 *
 * Uses the runtime's local timezone, NOT UTC. This matters near midnight
 * in UTC+1/+2 (Spain) where `toISOString().slice(0, 10)` would return
 * yesterday's date after local midnight.
 */
export function toLocalISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─── Lifecycle detection ────────────────────────────────────────────────────

/**
 * Where the user is relative to their plan.
 *
 * - `no_plan`: No running plan session, no future plan, and no active planning flow.
 * - `planning`: A `planFlow` is active and not yet confirmed.
 * - `upcoming`: A confirmed plan exists but hasn't started yet (horizon_start > today).
 * - `active_early`: Day 0 or day 1 of the plan horizon.
 * - `active_mid`: Days 2-4 of a 7-day horizon (the default).
 * - `active_ending`: 1-2 days remaining in the horizon.
 */
export type PlanLifecycle = 'no_plan' | 'planning' | 'upcoming' | 'active_early' | 'active_mid' | 'active_ending';

/**
 * Compute the user's plan lifecycle state.
 *
 * Async because it queries the store for running plan sessions. The store
 * call (`getRunningPlanSession`) is a single-row lookup — fast enough to
 * call per reply. Lifecycle is NOT cached on the session because it depends
 * on horizon dates relative to today and would go stale across day boundaries.
 *
 * @param session - Current bot session (checked for active planFlow)
 * @param store - State store for plan session queries
 * @param today - ISO date string for "today" (caller controls timezone)
 */
export async function getPlanLifecycle(
  session: BotCoreSession,
  store: StateStoreLike,
  today: string,
): Promise<PlanLifecycle> {
  // Active planning flow that isn't stale (confirmed flows should have been cleared)
  if (session.planFlow && session.planFlow.phase !== 'confirmed') {
    return 'planning';
  }

  const runningSession = await store.getRunningPlanSession(today);
  if (!runningSession) {
    const future = await store.getFuturePlanSessions(today);
    return future.length > 0 ? 'upcoming' : 'no_plan';
  }

  // Compute horizon position
  const daysSinceStart = dateDiffDays(today, runningSession.horizonStart);
  const daysUntilEnd = dateDiffDays(runningSession.horizonEnd, today);

  // Check active_ending first (takes priority when days overlap)
  if (daysUntilEnd <= 1) {
    return 'active_ending';
  }

  // Then active_early
  if (daysSinceStart <= 1) {
    return 'active_early';
  }

  // Default: active_mid
  return 'active_mid';
}

/**
 * Get the plan session the user should see right now.
 *
 * Priority: running plan (horizon contains today) > nearest future plan.
 * Returns null if no confirmed plan exists at all.
 *
 * This is the visibility query — use it everywhere the user expects
 * to "see their plan." Contrast with getRunningPlanSession which is
 * strictly date-range-gated and used for budget/solver logic.
 */
export async function getVisiblePlanSession(
  store: StateStoreLike,
  today: string,
): Promise<PlanSession | null> {
  const running = await store.getRunningPlanSession(today);
  if (running) return running;
  const future = await store.getFuturePlanSessions(today);
  return future.length > 0 ? future[0]! : null;
}

/**
 * Difference in calendar days between two ISO date strings: `a - b`.
 *
 * Pure function, no timezone concerns — operates on date strings directly.
 * Returns a positive number when `a` is after `b`.
 */
export function dateDiffDays(a: string, b: string): number {
  const msPerDay = 86_400_000;
  const dateA = new Date(a + 'T00:00:00Z');
  const dateB = new Date(b + 'T00:00:00Z');
  return Math.round((dateA.getTime() - dateB.getTime()) / msPerDay);
}

// ─── Plan data helpers ──────────────────────────────────────────────────────
//
// All helpers filter to status === 'planned' batches only — cancelled batches
// (tombstoned by D27 supersede) are excluded. Callers pass raw Batch[] from
// the store; the helpers handle the filter internally.

/** Filter to only planned (non-cancelled) batches. */
function plannedOnly(batches: Batch[]): Batch[] {
  return batches.filter((b) => b.status === 'planned');
}

/**
 * Find the next cook day on or after `today`.
 *
 * Cook day = `eatingDays[0]` for each batch. Returns the earliest such date
 * on or after `today`, along with all batches cooking on that date.
 *
 * Returns `null` if no future cook days exist.
 */
export function getNextCookDay(
  batches: Batch[],
  today: string,
): { date: string; batches: Batch[] } | null {
  const planned = plannedOnly(batches);
  const futureCooks = planned
    .filter((b) => b.eatingDays.length > 0 && b.eatingDays[0]! >= today)
    .sort((a, b) => a.eatingDays[0]!.localeCompare(b.eatingDays[0]!));

  if (futureCooks.length === 0) return null;

  const nextDate = futureCooks[0]!.eatingDays[0]!;
  return {
    date: nextDate,
    batches: futureCooks.filter((b) => b.eatingDays[0] === nextDate),
  };
}

/**
 * Group all batches by their cook day (`eatingDays[0]`), sorted chronologically.
 *
 * Returns an array of `{ date, batches }` entries — one per unique cook day.
 */
export function getCookDaysForWeek(
  batches: Batch[],
): { date: string; batches: Batch[] }[] {
  const planned = plannedOnly(batches);
  const byDate = new Map<string, Batch[]>();

  for (const b of planned) {
    if (b.eatingDays.length === 0) continue;
    const cookDay = b.eatingDays[0]!;
    const list = byDate.get(cookDay);
    if (list) {
      list.push(b);
    } else {
      byDate.set(cookDay, [b]);
    }
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, batchList]) => ({ date, batches: batchList }));
}

/**
 * Find the batch covering a given date and meal type.
 *
 * Returns the batch along with whether this date is a reheat (not the cook day)
 * and the serving number (1-indexed position in eatingDays).
 *
 * The solver guarantees at most one planned batch per slot — multiple matches
 * would indicate data corruption. Returns the first match.
 */
export function getBatchForMeal(
  batches: Batch[],
  date: string,
  mealType: 'lunch' | 'dinner',
): { batch: Batch; isReheat: boolean; servingNumber: number } | null {
  const planned = plannedOnly(batches);
  for (const b of planned) {
    if (b.mealType !== mealType) continue;
    if (b.eatingDays.includes(date)) {
      return {
        batch: b,
        isReheat: isReheat(b, date),
        servingNumber: getServingNumber(b, date),
      };
    }
  }
  return null;
}

/**
 * Whether `date` is a reheat day for this batch (not the cook day).
 * Cook day = `eatingDays[0]`, so any later date is a reheat.
 */
export function isReheat(batch: Batch, date: string): boolean {
  return batch.eatingDays.length > 0 && date > batch.eatingDays[0]!;
}

/**
 * 1-indexed serving number for `date` within this batch's eating days.
 * Returns `0` if `date` is not in `eatingDays` (defensive — should not
 * happen with correct callers).
 */
export function getServingNumber(batch: Batch, date: string): number {
  const idx = batch.eatingDays.indexOf(date);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * First and last eating day for a batch.
 * @deprecated Plan 024: use formatDayRange(batch.eatingDays) for display instead.
 * Kept alive because existing callers may still need raw first/last values.
 */
export function getDayRange(batch: Batch): { first: string; last: string } | null {
  if (batch.eatingDays.length === 0) return null;
  return {
    first: batch.eatingDays[0]!,
    last: batch.eatingDays[batch.eatingDays.length - 1]!,
  };
}

/**
 * Format an array of ISO dates into a human-readable compact range.
 * Handles non-contiguous days by splitting into runs of consecutive days.
 *
 * Plan 024: supports flexible (non-consecutive) batch eating days.
 *
 * Examples:
 *   ["2026-04-15","2026-04-16","2026-04-17"] → "Wed–Fri"
 *   ["2026-04-15","2026-04-17","2026-04-18"] → "Wed, Fri–Sat"
 *   ["2026-04-14","2026-04-16","2026-04-18"] → "Tue, Thu, Sat"
 *   ["2026-04-14"]                           → "Tue"
 */
export function formatDayRange(days: string[]): string {
  if (days.length === 0) return '';
  if (days.length === 1) return dayShort(days[0]!);

  // Split into runs of consecutive days
  const runs: string[][] = [];
  let currentRun: string[] = [days[0]!];

  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]! + 'T00:00:00');
    const curr = new Date(days[i]! + 'T00:00:00');
    const diffMs = curr.getTime() - prev.getTime();
    if (diffMs === 24 * 60 * 60 * 1000) {
      currentRun.push(days[i]!);
    } else {
      runs.push(currentRun);
      currentRun = [days[i]!];
    }
  }
  runs.push(currentRun);

  // Format each run
  return runs.map((run) => {
    if (run.length === 1) return dayShort(run[0]!);
    return `${dayShort(run[0]!)}–${dayShort(run[run.length - 1]!)}`;
  }).join(', ');
}

/** Short weekday name from ISO date (e.g., "Mon", "Tue"). */
function dayShort(isoDate: string): string {
  return new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
}
