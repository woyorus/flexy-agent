/**
 * Scenario 063 — show_progress weekly report via natural language.
 *
 * Plan 030 (Plan E). User types "how am I doing this week?" with a
 * measurement logged today and measurements from the prior completed week.
 * The dispatcher picks `show_progress({ view: 'weekly_report' })`, the
 * handler calls `renderProgressView('weekly_report')` which loads and
 * formats the weekly report.
 *
 * Seed: measurements from 2026-04-06 through 2026-04-12 (the plan week)
 * plus today (2026-04-13, Monday of the NEW week). The prior completed
 * week is Apr 6–12. The user has enough data points for the weekly
 * report to be meaningful.
 *
 * Clock: 2026-04-13T10:00:00Z (Monday of new week — the prior week
 * Apr 6–12 is "last completed week" for the progress report).
 *
 * No active plan session is needed — progress reporting works
 * independently of plan state.
 *
 * Sequence:
 *   1. Type "how am I doing this week?" — dispatcher picks show_progress
 *      weekly_report, handler renders.
 */

import { defineScenario, text } from '../../../src/harness/define.js';
import type { Measurement } from '../../../src/models/types.js';

/**
 * Measurements seed covering the prior completed week (Apr 6–12, Mon–Sun)
 * plus today (Apr 13, Monday). The weekly report needs at least 2–3
 * measurements from the last completed week plus today's measurement.
 */
const measurements: Measurement[] = [
  { id: 'meas-063-1', userId: 'default', date: '2026-04-13', weightKg: 81.8, waistCm: 90, createdAt: '2026-04-13T08:00:00Z' },
  { id: 'meas-063-2', userId: 'default', date: '2026-04-12', weightKg: 82.0, waistCm: 90, createdAt: '2026-04-12T08:00:00Z' },
  { id: 'meas-063-3', userId: 'default', date: '2026-04-11', weightKg: 82.1, waistCm: 91, createdAt: '2026-04-11T08:00:00Z' },
  { id: 'meas-063-4', userId: 'default', date: '2026-04-09', weightKg: 82.3, waistCm: 91, createdAt: '2026-04-09T08:00:00Z' },
  { id: 'meas-063-5', userId: 'default', date: '2026-04-07', weightKg: 82.5, waistCm: 91, createdAt: '2026-04-07T08:00:00Z' },
  { id: 'meas-063-6', userId: 'default', date: '2026-04-06', weightKg: 82.7, waistCm: 92, createdAt: '2026-04-06T08:00:00Z' },
];

export default defineScenario({
  name: '063-show-progress-weekly-report',
  description:
    'User types "how am I doing this week?" with measurements seeded. Dispatcher picks show_progress ' +
    'weekly_report, handler renders the progress report. Plan 030.',
  clock: '2026-04-13T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    session: null,
    measurements,
  },
  events: [
    text('how am I doing this week?'),
  ],
});
