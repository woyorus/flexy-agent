/**
 * Unit tests for progress flow pure functions and date utilities.
 *
 * Tests parseMeasurementInput, assignWeightWaist, getCalendarWeekBoundaries,
 * formatWeeklyReport, and pickWeeklyReportTone at granularity not covered
 * by the integration scenarios.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeasurementInput, assignWeightWaist } from '../../src/agents/progress-flow.js';
import { getCalendarWeekBoundaries } from '../../src/utils/dates.js';
import { formatWeeklyReport, pickWeeklyReportTone } from '../../src/telegram/formatters.js';
import type { Measurement } from '../../src/models/types.js';

// ─── parseMeasurementInput ──────────────────────────────────────────────────

describe('parseMeasurementInput', () => {
  it('parses a single number', () => {
    assert.deepStrictEqual(parseMeasurementInput('82.3'), { values: [82.3] });
  });

  it('parses two numbers with slash', () => {
    assert.deepStrictEqual(parseMeasurementInput('82.3 / 91'), { values: [82.3, 91] });
  });

  it('parses two numbers with comma', () => {
    assert.deepStrictEqual(parseMeasurementInput('82.3, 91'), { values: [82.3, 91] });
  });

  it('parses two numbers with space', () => {
    assert.deepStrictEqual(parseMeasurementInput('82.3 91'), { values: [82.3, 91] });
  });

  it('rejects three numbers', () => {
    assert.strictEqual(parseMeasurementInput('82.3 / 91 / 40'), null);
  });

  it('rejects negative', () => {
    assert.strictEqual(parseMeasurementInput('-5'), null);
  });

  it('rejects zero', () => {
    assert.strictEqual(parseMeasurementInput('0'), null);
  });

  it('rejects non-numeric text', () => {
    assert.strictEqual(parseMeasurementInput('hello'), null);
  });

  it('parses integer', () => {
    assert.deepStrictEqual(parseMeasurementInput('82'), { values: [82] });
  });
});

// ─── assignWeightWaist ──────────────────────────────────────────────────────

describe('assignWeightWaist', () => {
  it('unambiguous with clear prior data', () => {
    const prior: Measurement = {
      id: 'x', userId: 'default', date: '2026-04-01',
      weightKg: 82, waistCm: 91, createdAt: '',
    };
    const result = assignWeightWaist(82.5, 91.5, prior);
    assert.strictEqual(result.weight, 82.5);
    assert.strictEqual(result.waist, 91.5);
    assert.strictEqual(result.ambiguous, false);
  });

  it('ambiguous with no prior data', () => {
    const result = assignWeightWaist(82.5, 91.5, null);
    assert.strictEqual(result.ambiguous, true);
  });

  it('ambiguous when prior has no waist', () => {
    const prior: Measurement = {
      id: 'x', userId: 'default', date: '2026-04-01',
      weightKg: 82, waistCm: null, createdAt: '',
    };
    const result = assignWeightWaist(82.5, 91.5, prior);
    assert.strictEqual(result.ambiguous, true);
  });

  it('ambiguous when both closer to same value', () => {
    const prior: Measurement = {
      id: 'x', userId: 'default', date: '2026-04-01',
      weightKg: 82, waistCm: 91, createdAt: '',
    };
    // Both numbers close to weight
    const result = assignWeightWaist(82.1, 82.2, prior);
    assert.strictEqual(result.ambiguous, true);
  });

  it('swaps when a is closer to waist and b to weight', () => {
    const prior: Measurement = {
      id: 'x', userId: 'default', date: '2026-04-01',
      weightKg: 82, waistCm: 91, createdAt: '',
    };
    // a=91.2 closer to waist, b=82.1 closer to weight
    const result = assignWeightWaist(91.2, 82.1, prior);
    assert.strictEqual(result.weight, 82.1);
    assert.strictEqual(result.waist, 91.2);
    assert.strictEqual(result.ambiguous, false);
  });
});

// ─── getCalendarWeekBoundaries ──────────────────────────────────────────────

describe('getCalendarWeekBoundaries', () => {
  it('Wednesday Apr 9', () => {
    const b = getCalendarWeekBoundaries('2026-04-09');
    assert.strictEqual(b.currentWeekStart, '2026-04-06');
    assert.strictEqual(b.currentWeekEnd, '2026-04-12');
    assert.strictEqual(b.lastWeekStart, '2026-03-30');
    assert.strictEqual(b.lastWeekEnd, '2026-04-05');
    assert.strictEqual(b.prevWeekStart, '2026-03-23');
    assert.strictEqual(b.prevWeekEnd, '2026-03-29');
  });

  it('Sunday Apr 5 — last completed week IS the current week', () => {
    const b = getCalendarWeekBoundaries('2026-04-05');
    assert.strictEqual(b.currentWeekStart, '2026-03-30');
    assert.strictEqual(b.currentWeekEnd, '2026-04-05');
    // On Sunday, the current week is complete → lastWeek = current week
    assert.strictEqual(b.lastWeekStart, '2026-03-30');
    assert.strictEqual(b.lastWeekEnd, '2026-04-05');
    assert.strictEqual(b.prevWeekStart, '2026-03-23');
    assert.strictEqual(b.prevWeekEnd, '2026-03-29');
  });

  it('Monday Apr 7', () => {
    // Apr 7 2026 is Tuesday actually. Let me use Apr 6 which is Monday.
    const b = getCalendarWeekBoundaries('2026-04-06');
    assert.strictEqual(b.currentWeekStart, '2026-04-06');
    assert.strictEqual(b.currentWeekEnd, '2026-04-12');
    assert.strictEqual(b.lastWeekStart, '2026-03-30');
    assert.strictEqual(b.lastWeekEnd, '2026-04-05');
  });
});

// ─── pickWeeklyReportTone ───────────────────────────────────────────────────

describe('pickWeeklyReportTone', () => {
  it('loss > 0.5 kg', () => {
    const tone = pickWeeklyReportTone(82.0, 83.0, null, null);
    assert.ok(tone.includes('Great progress'));
  });

  it('loss 0.1-0.5 kg', () => {
    const tone = pickWeeklyReportTone(82.5, 82.8, null, null);
    assert.ok(tone.includes('Steady and sustainable'));
  });

  it('plateau with waist down', () => {
    const tone = pickWeeklyReportTone(82.5, 82.5, 90.0, 91.0);
    assert.ok(tone.includes('recomposing'));
  });

  it('plateau without waist', () => {
    const tone = pickWeeklyReportTone(82.5, 82.5, null, null);
    assert.ok(tone.includes('stable'));
  });

  it('gain >= 0.3 kg', () => {
    const tone = pickWeeklyReportTone(83.0, 82.5, null, null);
    assert.ok(tone.includes('fluctuations'));
  });
});

// ─── formatWeeklyReport ─────────────────────────────────────────────────────

describe('formatWeeklyReport', () => {
  const makeMeasurement = (date: string, weight: number, waist: number | null): Measurement => ({
    id: `m-${date}`, userId: 'default', date, weightKg: weight, waistCm: waist, createdAt: '',
  });

  it('no previous week shows no delta', () => {
    const current = [makeMeasurement('2026-04-06', 82.0, 91.0)];
    const report = formatWeeklyReport(current, [], '2026-04-06', '2026-04-12');
    assert.ok(report.includes('82.0 kg'));
    assert.ok(report.includes('delta shown once'));
    assert.ok(!report.includes('from last week'));
  });

  it('waist absent from current week omits waist line', () => {
    const current = [makeMeasurement('2026-04-06', 82.0, null)];
    const prev = [makeMeasurement('2026-03-30', 83.0, 91.0)];
    const report = formatWeeklyReport(current, prev, '2026-04-06', '2026-04-12');
    assert.ok(report.includes('Weight:'));
    assert.ok(!report.includes('Waist:'));
  });

  it('shows deltas when previous data exists', () => {
    const current = [makeMeasurement('2026-04-06', 82.0, 91.0)];
    const prev = [makeMeasurement('2026-03-30', 83.0, 92.0)];
    const report = formatWeeklyReport(current, prev, '2026-04-06', '2026-04-12');
    assert.ok(report.includes('from last week'));
    assert.ok(report.includes('↓'));
  });
});
