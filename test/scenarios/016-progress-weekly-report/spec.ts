import { defineScenario, text, click } from '../../../src/harness/define.js';
import type { Measurement } from '../../../src/models/types.js';

// Clock: Monday Apr 13 — last completed week is Mon Apr 6 – Sun Apr 12.
// Previous week: Mon Mar 30 – Sun Apr 5.
const LAST_WEEK_MEASUREMENTS: Measurement[] = [
  { id: 'meas-1', userId: 'default', date: '2026-04-06', weightKg: 82.5, waistCm: 91.5, createdAt: '2026-04-06T08:00:00Z' },
  { id: 'meas-2', userId: 'default', date: '2026-04-07', weightKg: 82.3, waistCm: 91.2, createdAt: '2026-04-07T08:00:00Z' },
  { id: 'meas-3', userId: 'default', date: '2026-04-08', weightKg: 82.1, waistCm: 91.0, createdAt: '2026-04-08T08:00:00Z' },
  { id: 'meas-4', userId: 'default', date: '2026-04-09', weightKg: 82.4, waistCm: 91.1, createdAt: '2026-04-09T08:00:00Z' },
  { id: 'meas-5', userId: 'default', date: '2026-04-10', weightKg: 82.2, waistCm: 90.9, createdAt: '2026-04-10T08:00:00Z' },
  { id: 'meas-6', userId: 'default', date: '2026-04-11', weightKg: 82.0, waistCm: 90.8, createdAt: '2026-04-11T08:00:00Z' },
  { id: 'meas-7', userId: 'default', date: '2026-04-12', weightKg: 81.9, waistCm: 90.7, createdAt: '2026-04-12T08:00:00Z' },
];
const PREV_WEEK_MEASUREMENTS: Measurement[] = [
  { id: 'meas-8', userId: 'default', date: '2026-03-30', weightKg: 83.1, waistCm: 92.0, createdAt: '2026-03-30T08:00:00Z' },
  { id: 'meas-9', userId: 'default', date: '2026-03-31', weightKg: 82.9, waistCm: 91.8, createdAt: '2026-03-31T08:00:00Z' },
];

export default defineScenario({
  name: '016-progress-weekly-report',
  description: 'Progress: tap [Last weekly report] with a full completed week seeded — verifies tone, averages, and delta computation',
  clock: '2026-04-13T10:00:00Z',   // Monday — last completed week Apr 6–12 is fully past
  recipeSet: 'minimal',
  initialState: {
    measurements: [...LAST_WEEK_MEASUREMENTS, ...PREV_WEEK_MEASUREMENTS],
  },
  events: [
    text('📊 Progress'),           // no measurement today (Apr 13) → gets prompt
    text('82.0'),                  // log today (weight only)
    click('pg_last_report'),       // completed week Apr 6–12 exists → show report
  ],
});
