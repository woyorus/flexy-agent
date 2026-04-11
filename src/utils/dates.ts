/**
 * Calendar week boundary utilities for progress tracking.
 *
 * Calendar weeks are Mon-Sun. "Last completed week" means the most recent
 * Mon-Sun where lastWeekEnd <= today. Sunday counts as complete — if today
 * is Sunday, the last completed week ends today.
 *
 * Used by the progress menu handler (to decide if [Last weekly report] button
 * should appear) and by the weekly report formatter (to compute averages and deltas).
 */

/**
 * Compute calendar week boundaries relative to `today`.
 *
 * Returns three week ranges:
 * - currentWeek: the Mon-Sun containing `today`
 * - lastWeek: the most recent completed Mon-Sun where lastWeekEnd <= today.
 *   On Sunday, this IS the current week (it just ended). On Mon-Sat, it's
 *   the previous Mon-Sun.
 * - prevWeek: the week before lastWeek (for delta computation in reports)
 *
 * @param today - ISO date string (YYYY-MM-DD)
 */
export function getCalendarWeekBoundaries(today: string): {
  currentWeekStart: string;
  currentWeekEnd: string;
  lastWeekStart: string;
  lastWeekEnd: string;
  prevWeekStart: string;
  prevWeekEnd: string;
} {
  const d = new Date(today + 'T00:00:00Z');
  // JS getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat
  const dow = d.getUTCDay();
  // Days since Monday (Mon=0, Tue=1, ..., Sun=6)
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const isSunday = dow === 0;

  // Current week's Monday
  const currentMon = new Date(d);
  currentMon.setUTCDate(d.getUTCDate() - daysSinceMonday);

  // Current week's Sunday
  const currentSun = new Date(currentMon);
  currentSun.setUTCDate(currentMon.getUTCDate() + 6);

  // "Last completed week": on Sunday the current week is complete, so
  // lastWeek = current week. On Mon-Sat, lastWeek = previous Mon-Sun.
  let lastMon: Date;
  let lastSun: Date;
  if (isSunday) {
    lastMon = new Date(currentMon);
    lastSun = new Date(currentSun);
  } else {
    lastMon = new Date(currentMon);
    lastMon.setUTCDate(currentMon.getUTCDate() - 7);
    lastSun = new Date(currentMon);
    lastSun.setUTCDate(currentMon.getUTCDate() - 1);
  }

  // Previous week (before last completed week)
  const prevMon = new Date(lastMon);
  prevMon.setUTCDate(lastMon.getUTCDate() - 7);
  const prevSun = new Date(lastMon);
  prevSun.setUTCDate(lastMon.getUTCDate() - 1);

  return {
    currentWeekStart: toISODate(currentMon),
    currentWeekEnd: toISODate(currentSun),
    lastWeekStart: toISODate(lastMon),
    lastWeekEnd: toISODate(lastSun),
    prevWeekStart: toISODate(prevMon),
    prevWeekEnd: toISODate(prevSun),
  };
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Format an ISO date string ('YYYY-MM-DD') as a human-readable label for
 * Telegram messages. Returns short English weekday + short month + day,
 * e.g. "Mon, Apr 6". Used by `getPlanFlowResumeView` and any other view
 * code that wants a compact day label without dragging in `Intl.DateTimeFormat`
 * configuration.
 *
 * Moved from `src/telegram/core.ts` in Plan 028 Task 8b so the new
 * flow-resume-views module can import it without pulling in core.ts.
 */
export function formatDateForMessage(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
