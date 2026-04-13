/**
 * Scenario-local assertions for 042-dispatcher-numeric-prefilter.
 *
 * Plan 032 Wave G — numeric pre-filter short-circuits for
 * `awaiting_measurement`: the numeric text is consumed without reaching
 * the dispatcher; the measurement persists. A later non-numeric text
 * dispatches normally (show_progress in this recording).
 */

import {
  assertDispatcherActions,
  assertMeasurementPersisted,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'While awaiting a measurement, a numeric text short-circuits before the ' +
  'dispatcher and persists via logMeasurement. A subsequent non-numeric ' +
  'text dispatches normally (show_progress here).';

export function assertBehavior(ctx: AssertionsContext): void {
  // The numeric text did NOT reach the dispatcher (only the later text did).
  assertDispatcherActions(ctx, ['show_progress']);

  // logMeasurement persisted.
  const hasLog = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'logMeasurement',
  );
  if (!hasLog) {
    throw new Error('Expected logMeasurement persistence op; got none.');
  }
  // The measurement is in the store. The scenario clock is 2026-04-10
  // (Friday — setup puts user in awaiting_measurement state).
  assertMeasurementPersisted(ctx, { date: '2026-04-10' });
}
