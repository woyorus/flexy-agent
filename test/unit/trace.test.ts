/**
 * Unit coverage for `HarnessTraceCollector.summarize()`.
 *
 * The collector is intentionally dumb — it records every event it's given
 * and groups them by kind at summary time. These tests ensure the grouping
 * preserves insertion order within each kind, and that absent kinds produce
 * empty arrays (never undefined).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessTraceCollector } from '../../src/harness/trace.js';

test('HarnessTraceCollector summarize groups events by kind and preserves order', () => {
  const c = new HarnessTraceCollector();
  c.record({ kind: 'handler', name: 'dispatch:command' });
  c.record({ kind: 'dispatcher', action: 'plan_week', params: { foo: 1 } });
  c.record({ kind: 'handler', name: 'callback:plan_approve' });
  c.record({ kind: 'retry', validator: 'plan-proposer', attempt: 2, errors: ['slot uncovered'] });
  c.record({ kind: 'persist', op: 'confirmPlanSession' });
  c.record({ kind: 'handler', name: 'callback:plan_view' });
  c.record({ kind: 'persist', op: 'logMeasurement', argSummary: 'day=2026-04-13' });

  const summary = c.summarize();

  assert.deepStrictEqual(summary.handlers, [
    'dispatch:command',
    'callback:plan_approve',
    'callback:plan_view',
  ]);
  assert.deepStrictEqual(summary.dispatcherActions, [
    { action: 'plan_week', params: { foo: 1 } },
  ]);
  assert.deepStrictEqual(summary.validatorRetries, [
    { validator: 'plan-proposer', attempt: 2, errors: ['slot uncovered'] },
  ]);
  assert.deepStrictEqual(summary.persistenceOps, [
    { op: 'confirmPlanSession', argSummary: undefined },
    { op: 'logMeasurement', argSummary: 'day=2026-04-13' },
  ]);
});

test('HarnessTraceCollector summarize returns empty arrays for absent kinds', () => {
  const c = new HarnessTraceCollector();
  c.record({ kind: 'handler', name: 'dispatch:text' });
  const summary = c.summarize();
  assert.deepStrictEqual(summary.handlers, ['dispatch:text']);
  assert.deepStrictEqual(summary.dispatcherActions, []);
  assert.deepStrictEqual(summary.validatorRetries, []);
  assert.deepStrictEqual(summary.persistenceOps, []);
});

test('HarnessTraceCollector.record is bindable (can pass as a plain function reference)', () => {
  const c = new HarnessTraceCollector();
  const emit = c.record; // detach from the collector — validates the arrow-function binding
  emit({ kind: 'handler', name: 'test' });
  assert.deepStrictEqual(c.summarize().handlers, ['test']);
});
