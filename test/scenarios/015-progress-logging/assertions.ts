/**
 * Scenario-local assertions for 015-progress-logging.
 *
 * Plan 032 Wave D — exercises four adjacent progress-flow branches in one
 * scenario: first measurement (with disambiguation between weight/waist),
 * already-logged-today guard, and defensive pg_last_report when no
 * completed week exists.
 */

import { assertMeasurementPersisted } from '../../../src/harness/index.js';
import type { AssertionsContext } from '../../../src/harness/index.js';

export const purpose =
  'The progress flow accepts the first measurement via the canonical entry, ' +
  'disambiguates weight vs waist, persists the entry, blocks a same-day ' +
  're-log, and gracefully handles pg_last_report when no completed week ' +
  'exists.';

export function assertBehavior(ctx: AssertionsContext): void {
  // Measurement persisted via disambig-yes.
  assertMeasurementPersisted(ctx, {
    date: '2026-04-09',
    weightKg: 82.3,
    waistCm: 91,
  });

  // Disambig handler fired.
  if (!ctx.execTrace.handlers.includes('callback:pg_disambig_yes')) {
    throw new Error('Expected callback:pg_disambig_yes in handlers; not found.');
  }

  // Already-logged-today guard fired (visible as a transcript output).
  const alreadyLogged = ctx.outputs.find(
    (o) => typeof o.text === 'string' && /already logged/i.test(o.text),
  );
  if (!alreadyLogged) {
    throw new Error('Expected an "Already logged" message; not found.');
  }

  // Defensive pg_last_report response when no completed week exists.
  const noReport = ctx.outputs.find(
    (o) => typeof o.text === 'string' && /not enough data|first report/i.test(o.text),
  );
  if (!noReport) {
    throw new Error(
      'Expected a "not enough data" / first-report message; not found.',
    );
  }

  // logMeasurement persistence op happened.
  const persisted = ctx.execTrace.persistenceOps.some(
    (o) => o.op === 'logMeasurement',
  );
  if (!persisted) {
    throw new Error('Expected a logMeasurement persistence op; got none.');
  }
}
