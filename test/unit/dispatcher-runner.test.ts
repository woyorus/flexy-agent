/**
 * Unit tests for `dispatcher-runner.ts` helpers — Plan 028.
 *
 * Task 2 covers only `pushTurn` (ring buffer + cap). Task 8 will extend
 * this file with tests for `buildDispatcherContext`, `runDispatcherFrontDoor`,
 * and the action handlers.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  pushTurn,
  RECENT_TURNS_MAX,
  type ConversationTurn,
} from '../../src/telegram/dispatcher-runner.js';

function newSession(): { recentTurns: ConversationTurn[] } {
  return { recentTurns: [] };
}

test('pushTurn: appends a user turn', () => {
  const s = newSession();
  pushTurn(s, 'user', 'hello');
  assert.equal(s.recentTurns.length, 1);
  assert.equal(s.recentTurns[0]!.role, 'user');
  assert.equal(s.recentTurns[0]!.text, 'hello');
  assert.match(s.recentTurns[0]!.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('pushTurn: appends a bot turn', () => {
  const s = newSession();
  pushTurn(s, 'bot', 'hi');
  assert.equal(s.recentTurns[0]!.role, 'bot');
  assert.equal(s.recentTurns[0]!.text, 'hi');
});

test('pushTurn: preserves order across multiple turns', () => {
  const s = newSession();
  pushTurn(s, 'user', 'one');
  pushTurn(s, 'bot', 'two');
  pushTurn(s, 'user', 'three');
  assert.deepStrictEqual(
    s.recentTurns.map((t) => t.text),
    ['one', 'two', 'three'],
  );
});

test(`pushTurn: caps at RECENT_TURNS_MAX (${RECENT_TURNS_MAX})`, () => {
  const s = newSession();
  for (let i = 0; i < RECENT_TURNS_MAX + 4; i++) {
    pushTurn(s, 'user', `turn-${i}`);
  }
  assert.equal(s.recentTurns.length, RECENT_TURNS_MAX);
  // The oldest four turns are dropped; the remaining are the newest ones.
  assert.equal(s.recentTurns[0]!.text, `turn-${4}`);
  assert.equal(
    s.recentTurns[RECENT_TURNS_MAX - 1]!.text,
    `turn-${RECENT_TURNS_MAX + 3}`,
  );
});

test('pushTurn: mutates the passed session object (no return value)', () => {
  const s = newSession();
  const result = pushTurn(s, 'user', 'x') as unknown;
  assert.equal(result, undefined);
  assert.equal(s.recentTurns.length, 1);
});

test('pushTurn: does not touch unrelated fields on the session', () => {
  const s: { recentTurns: ConversationTurn[]; marker?: string } = {
    recentTurns: [],
    marker: 'keep-me',
  };
  pushTurn(s, 'user', 'x');
  assert.equal(s.marker, 'keep-me');
});

test('pushTurn: initializes recentTurns on first write when field is absent', () => {
  const s: { recentTurns?: ConversationTurn[] } = {};
  pushTurn(s, 'user', 'x');
  assert.ok(Array.isArray(s.recentTurns));
  assert.equal(s.recentTurns!.length, 1);
});
