/**
 * Scenario-local assertions for 064-log-measurement-cross-surface.
 *
 * Plan 032 Wave I — log_measurement dispatched from a non-progress
 * surface. surfaceContext stays on the originating surface; the
 * measurement persists via logMeasurement.
 */

import {
  assertDispatcherActions,
  assertMeasurementPersisted,
} from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'Typing a measurement from a non-progress surface (here: My Plan) routes ' +
  'through log_measurement, persists via logMeasurement, and preserves ' +
  'surfaceContext on the originating surface.';

export function assertBehavior(ctx: AssertionsContext): void {
  assertDispatcherActions(ctx, ['log_measurement']);

  const hasLog = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'logMeasurement',
  );
  if (!hasLog) throw new Error('Expected logMeasurement persistence op.');

  // surfaceContext is still 'plan' (the menu the user was on before typing).
  const session = ctx.finalSession as
    | { surfaceContext?: string | null }
    | null
    | undefined;
  if (session?.surfaceContext !== 'plan') {
    throw new Error(
      `Expected surfaceContext='plan' preserved; got ${String(session?.surfaceContext)}.`,
    );
  }
}
