/**
 * Scenario-local assertions for 016-progress-weekly-report.
 *
 * Plan 032 Wave D — full completed week seeded; user logs today's weight,
 * taps [Last weekly report], gets a well-formed report covering Apr 6–12.
 */

import {
  assertMeasurementPersisted,
  assertWeeklyReportShape,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Given a fully-seeded prior week, logging today\'s measurement and ' +
  'tapping [Last weekly report] produces a well-formed report (averages + ' +
  'deltas, no undefined leaks) for the completed week.';

export function assertBehavior(ctx: AssertionsContext): void {
  // Today's measurement persisted (Apr 13, weight 82.0).
  assertMeasurementPersisted(ctx, {
    date: '2026-04-13',
    weightKg: 82.0,
  });

  // Weekly report is well-formed.
  assertWeeklyReportShape(ctx);

  // pg_last_report callback fired.
  if (!ctx.execTrace.handlers.includes('callback:pg_last_report')) {
    throw new Error('Expected callback:pg_last_report in handlers; not found.');
  }
}
