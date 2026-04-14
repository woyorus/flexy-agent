/**
 * Unit tests for `scoreCandidatesForPick` — multi-batch pre-filter
 * picker logic from src/telegram/dispatcher-runner.ts.
 *
 * Regression protection for a Codex finding on the
 * `plan-033-ingredient-swap` branch: the preview footer tells users
 * "Pick 'both', a number, or tell me which one by name" but the scorer
 * didn't recognise numeric replies (only ordinal words like "first" /
 * "second"). A user typing "1" or "2" fell through to the dispatcher
 * LLM, which could re-route awkwardly.
 *
 * Per proposal 008 Commitment B: this unit test ships with the fix
 * that added the numeric-match branch so any future regression here
 * fails in milliseconds rather than waiting for an end-to-end scenario
 * regen.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { scoreCandidatesForPick } from '../../src/telegram/dispatcher-runner.js';

/** Minimal candidate fixture — only the fields the scorer reads. */
function candidate(targetId: string, description: string, shortName: string, mealType: 'lunch' | 'dinner' | 'breakfast'): {
  targetId: string;
  description: string;
  shortName: string;
  mealType: 'lunch' | 'dinner' | 'breakfast';
} {
  return { targetId, description, shortName, mealType };
}

const CANDIDATES = [
  candidate('batch-a', 'Chicken Black Bean Bowl (lunch Mon–Wed)', 'Chicken Black Bean Bowl', 'lunch'),
  candidate('batch-b', 'Chicken Black Bean Bowl (dinner Thu–Fri)', 'Chicken Black Bean Bowl', 'dinner'),
];

test('scoreCandidatesForPick: numeric "1" binds to candidates[0]', () => {
  const r = scoreCandidatesForPick(CANDIDATES, '1');
  assert.deepStrictEqual(r, { targetId: 'batch-a' });
});

test('scoreCandidatesForPick: numeric "2" binds to candidates[1]', () => {
  const r = scoreCandidatesForPick(CANDIDATES, '2');
  assert.deepStrictEqual(r, { targetId: 'batch-b' });
});

test('scoreCandidatesForPick: "#2" (hash prefix) also binds to candidates[1]', () => {
  const r = scoreCandidatesForPick(CANDIDATES, '#2');
  assert.deepStrictEqual(r, { targetId: 'batch-b' });
});

test('scoreCandidatesForPick: trailing period on a number is OK', () => {
  const r = scoreCandidatesForPick(CANDIDATES, '1.');
  assert.deepStrictEqual(r, { targetId: 'batch-a' });
});

test('scoreCandidatesForPick: out-of-range numeric returns null (not a spurious match)', () => {
  const r = scoreCandidatesForPick(CANDIDATES, '5');
  assert.strictEqual(r, null);
});

test('scoreCandidatesForPick: "0" (below range) returns null', () => {
  const r = scoreCandidatesForPick(CANDIDATES, '0');
  assert.strictEqual(r, null);
});

test('scoreCandidatesForPick: ordinal word "first" still works after the numeric branch', () => {
  const r = scoreCandidatesForPick(CANDIDATES, 'first');
  assert.deepStrictEqual(r, { targetId: 'batch-a' });
});

test('scoreCandidatesForPick: mealType match "the lunch one" binds to the unique lunch candidate', () => {
  const r = scoreCandidatesForPick(CANDIDATES, 'the lunch one');
  assert.deepStrictEqual(r, { targetId: 'batch-a' });
});

test('scoreCandidatesForPick: ambiguous mealType (multiple lunches) returns null', () => {
  const twoLunches = [
    candidate('a', 'A (lunch Mon)', 'A', 'lunch'),
    candidate('b', 'B (lunch Wed)', 'B', 'lunch'),
  ];
  const r = scoreCandidatesForPick(twoLunches, 'the lunch one');
  assert.strictEqual(r, null);
});

test('scoreCandidatesForPick: substring match requires the user to type the full shortName', () => {
  // Current behavior: user-text-contains-candidate-text (NOT reverse).
  // This means "the tagine" does NOT match shortName "Beef Tagine" —
  // the user has to type the whole short name. Real users won't
  // naturally do this; proposal 007 (LLM-first text understanding) is
  // expected to lift the whole picker-regex layer and route through
  // the dispatcher. Until then, this test locks in the current
  // restrictive behavior so it doesn't regress into something else
  // brittle.
  const distinct = [
    candidate('a', 'Chicken Black Bean Bowl (lunch)', 'Chicken Bowl', 'lunch'),
    candidate('b', 'Beef Tagine (dinner)', 'Beef Tagine', 'dinner'),
  ];
  const full = scoreCandidatesForPick(distinct, 'beef tagine');
  assert.deepStrictEqual(full, { targetId: 'b' });
  const partial = scoreCandidatesForPick(distinct, 'the tagine');
  assert.strictEqual(partial, null, 'Partial-name matching is not supported by the current hardcoded picker; proposal 007 handles this.');
});

test('scoreCandidatesForPick: ambiguous substring match across candidates returns null', () => {
  // Both candidates share "Chicken" in their shortName — no unique match.
  const r = scoreCandidatesForPick(CANDIDATES, 'chicken');
  assert.strictEqual(r, null);
});

test('scoreCandidatesForPick: nonsense text returns null', () => {
  const r = scoreCandidatesForPick(CANDIDATES, 'xyz random text 123');
  assert.strictEqual(r, null);
});
