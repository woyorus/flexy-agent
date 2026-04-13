/**
 * Unit coverage for `runGlobalInvariants` — GI-01..GI-06.
 *
 * Each invariant has a positive (passing) and negative (failing) case built
 * around a minimal hand-shaped `RecordedScenario` / `CapturedOutput[]` pair.
 * The scenario suite provides real-world positive coverage; these unit
 * tests guard the regex/shape logic in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGlobalInvariants, type InvariantResult } from '../../src/harness/invariants.js';
import type { CapturedOutput, RecordedScenario } from '../../src/harness/types.js';

function baseRecorded(overrides: Partial<RecordedScenario> = {}): RecordedScenario {
  return {
    generatedAt: '2026-04-13T12:00:00.000Z',
    specHash: 'a'.repeat(64),
    llmFixtures: [],
    expected: {
      outputs: [],
      finalSession: null,
      finalStore: null,
    },
    ...overrides,
  };
}

function out(text: string, keyboard?: CapturedOutput['keyboard']): CapturedOutput {
  return keyboard ? { text, keyboard } : { text };
}

function findResult(results: InvariantResult[], id: string): InvariantResult {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`invariant ${id} not in results`);
  return r;
}

// ─── GI-01 recording-well-formed ──────────────────────────────────────────────

test('GI-01 passes on well-formed recording', () => {
  const results = runGlobalInvariants(baseRecorded(), []);
  assert.equal(findResult(results, 'GI-01-recording-well-formed').passed, true);
});

test('GI-01 fails when generatedAt is not an ISO timestamp', () => {
  const results = runGlobalInvariants(baseRecorded({ generatedAt: 'yesterday' }), []);
  const r = findResult(results, 'GI-01-recording-well-formed');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /ISO timestamp/);
});

test('GI-01 fails when specHash is not 64-char hex', () => {
  const results = runGlobalInvariants(baseRecorded({ specHash: 'nothex' }), []);
  const r = findResult(results, 'GI-01-recording-well-formed');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /64-char hex/);
});

test('GI-01 fails when llmFixtures is not an array', () => {
  const results = runGlobalInvariants(
    baseRecorded({ llmFixtures: {} as unknown as RecordedScenario['llmFixtures'] }),
    [],
  );
  const r = findResult(results, 'GI-01-recording-well-formed');
  assert.equal(r.passed, false);
});

test('GI-01 fails when finalSession is undefined', () => {
  const broken = baseRecorded();
  (broken.expected as unknown as { finalSession?: unknown }).finalSession = undefined;
  const results = runGlobalInvariants(broken, []);
  const r = findResult(results, 'GI-01-recording-well-formed');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /finalSession/);
});

// ─── GI-02 no-fallback-messages ───────────────────────────────────────────────

test('GI-02 passes on non-error transcript', () => {
  const results = runGlobalInvariants(baseRecorded(), [out('Welcome to Flexie.')]);
  assert.equal(findResult(results, 'GI-02-no-fallback-messages').passed, true);
});

test('GI-02 fails when an output contains "Something went wrong"', () => {
  const results = runGlobalInvariants(
    baseRecorded(),
    [out('hello'), out('Something went wrong. Try again.')],
  );
  const r = findResult(results, 'GI-02-no-fallback-messages');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /outputs\[1\]/);
});

// ─── GI-03 no-undefined-or-stringified-objects ────────────────────────────────

test('GI-03 passes on clean transcript', () => {
  const results = runGlobalInvariants(baseRecorded(), [out('Your plan is ready.')]);
  assert.equal(findResult(results, 'GI-03-no-undefined-or-stringified-objects').passed, true);
});

test('GI-03 fails on literal "undefined" substring', () => {
  const results = runGlobalInvariants(
    baseRecorded(),
    [out('Calories: undefined kcal')],
  );
  const r = findResult(results, 'GI-03-no-undefined-or-stringified-objects');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /outputs\[0\]/);
});

test('GI-03 tolerates "undefined" in a larger word', () => {
  // Word-boundary regex must not flag "undefinedly" or "preundefined" or
  // "reading" etc. Here we ensure a substring that is not its own word
  // does not trip the check.
  const results = runGlobalInvariants(
    baseRecorded(),
    [out('The modelundefinedly is okay')],
  );
  assert.equal(findResult(results, 'GI-03-no-undefined-or-stringified-objects').passed, true);
});

test('GI-03 fails on "[object Object]"', () => {
  const results = runGlobalInvariants(
    baseRecorded(),
    [out('Plan: [object Object]')],
  );
  const r = findResult(results, 'GI-03-no-undefined-or-stringified-objects');
  assert.equal(r.passed, false);
});

// ─── GI-04 no-empty-replies ───────────────────────────────────────────────────

test('GI-04 passes when every text is non-empty', () => {
  const results = runGlobalInvariants(baseRecorded(), [out('hi'), out('there')]);
  assert.equal(findResult(results, 'GI-04-no-empty-replies').passed, true);
});

test('GI-04 fails on empty string', () => {
  const results = runGlobalInvariants(baseRecorded(), [out('')]);
  const r = findResult(results, 'GI-04-no-empty-replies');
  assert.equal(r.passed, false);
});

test('GI-04 fails on whitespace-only text', () => {
  const results = runGlobalInvariants(baseRecorded(), [out('   \n  ')]);
  const r = findResult(results, 'GI-04-no-empty-replies');
  assert.equal(r.passed, false);
});

// ─── GI-05 keyboards-non-empty ────────────────────────────────────────────────

test('GI-05 passes on well-formed reply keyboard', () => {
  const results = runGlobalInvariants(baseRecorded(), [
    out('hi', { kind: 'reply', buttons: [['a', 'b'], ['c']] }),
  ]);
  assert.equal(findResult(results, 'GI-05-keyboards-non-empty').passed, true);
});

test('GI-05 passes on well-formed inline keyboard', () => {
  const results = runGlobalInvariants(baseRecorded(), [
    out('hi', { kind: 'inline', buttons: [[{ label: 'OK', callback: 'ok' }]] }),
  ]);
  assert.equal(findResult(results, 'GI-05-keyboards-non-empty').passed, true);
});

test('GI-05 passes when no keyboard is present', () => {
  const results = runGlobalInvariants(baseRecorded(), [out('hi')]);
  assert.equal(findResult(results, 'GI-05-keyboards-non-empty').passed, true);
});

test('GI-05 fails on reply keyboard with zero rows', () => {
  const results = runGlobalInvariants(baseRecorded(), [
    out('hi', { kind: 'reply', buttons: [] }),
  ]);
  const r = findResult(results, 'GI-05-keyboards-non-empty');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /no rows/);
});

test('GI-05 fails on reply keyboard with empty row', () => {
  const results = runGlobalInvariants(baseRecorded(), [
    out('hi', { kind: 'reply', buttons: [['ok'], []] }),
  ]);
  const r = findResult(results, 'GI-05-keyboards-non-empty');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /row 1 is empty/);
});

test('GI-05 fails on inline keyboard with zero rows', () => {
  const results = runGlobalInvariants(baseRecorded(), [
    out('hi', { kind: 'inline', buttons: [] }),
  ]);
  const r = findResult(results, 'GI-05-keyboards-non-empty');
  assert.equal(r.passed, false);
});

// ─── GI-06 uuids-normalized ───────────────────────────────────────────────────

test('GI-06 passes when no raw UUID in expected block', () => {
  const results = runGlobalInvariants(baseRecorded(), []);
  assert.equal(findResult(results, 'GI-06-uuids-normalized').passed, true);
});

test('GI-06 fails when a raw UUID (v4-shaped) sneaks into recorded.expected', () => {
  // A real v4 UUID has version nibble 4 and variant nibble 8/9/a/b.
  const broken = baseRecorded();
  broken.expected = {
    outputs: [{ text: 'session a3f1c0d2-1234-4abc-9def-012345678abc ready' }],
    finalSession: null,
    finalStore: null,
  };
  const results = runGlobalInvariants(broken, [out('hi')]);
  const r = findResult(results, 'GI-06-uuids-normalized');
  assert.equal(r.passed, false);
  assert.match(r.message ?? '', /a3f1c0d2/);
});

test('GI-06 tolerates zero-pattern placeholder IDs used in spec seeding', () => {
  // Stable test-owned IDs like `session-a-00000000-0000-0000-0000-000000000001`
  // are deterministic placeholders (version nibble 0). They must not trip
  // the invariant — otherwise legitimate rolling-horizon scenarios fail.
  const broken = baseRecorded();
  broken.expected = {
    outputs: [
      { text: 'plan session-a-00000000-0000-0000-0000-000000000001 ready' },
    ],
    finalSession: null,
    finalStore: null,
  };
  const results = runGlobalInvariants(broken, [out('hi')]);
  assert.equal(findResult(results, 'GI-06-uuids-normalized').passed, true);
});
