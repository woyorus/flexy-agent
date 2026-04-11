/**
 * Unit tests for `setLastRenderedView` — Plan 027.
 *
 * Verifies every `LastRenderedView` variant round-trips onto a session
 * slice correctly and that `surfaceContext` always mirrors the view's
 * surface field. Plain objects are used as session slices so the test
 * doesn't need to construct a full BotCore.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setLastRenderedView,
  type LastRenderedView,
  type NavigationSessionSlice,
} from '../../src/telegram/navigation-state.js';

/** Fresh slice with both tracked fields cleared. */
function newSlice(): NavigationSessionSlice {
  return { surfaceContext: null, lastRenderedView: undefined };
}

test('setLastRenderedView: plan/next_action', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'plan', view: 'next_action' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'plan');
});

test('setLastRenderedView: plan/week_overview', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'plan', view: 'week_overview' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'plan');
});

test('setLastRenderedView: plan/day_detail carries day', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'plan', view: 'day_detail', day: '2026-04-09' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'plan');
});

test('setLastRenderedView: cooking/cook_view carries batchId and recipeSlug', () => {
  const s = newSlice();
  const view: LastRenderedView = {
    surface: 'cooking',
    view: 'cook_view',
    batchId: 'batch-123',
    recipeSlug: 'moroccan-beef-tagine',
  };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'cooking');
});

test('setLastRenderedView: shopping/next_cook', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'shopping', view: 'next_cook' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'shopping');
});

test('setLastRenderedView: shopping/day carries day', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'shopping', view: 'day', day: '2026-04-09' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'shopping');
});

test('setLastRenderedView: recipes/library', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'recipes', view: 'library' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'recipes');
});

test('setLastRenderedView: recipes/recipe_detail carries slug', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'recipes', view: 'recipe_detail', slug: 'lemon-chicken' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'recipes');
});

test('setLastRenderedView: progress/log_prompt', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'progress', view: 'log_prompt' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'progress');
});

test('setLastRenderedView: progress/weekly_report', () => {
  const s = newSlice();
  const view: LastRenderedView = { surface: 'progress', view: 'weekly_report' };
  setLastRenderedView(s, view);
  assert.deepStrictEqual(s.lastRenderedView, view);
  assert.equal(s.surfaceContext, 'progress');
});

test('setLastRenderedView: setting a new view replaces an older one', () => {
  const s = newSlice();
  setLastRenderedView(s, { surface: 'plan', view: 'next_action' });
  setLastRenderedView(s, { surface: 'shopping', view: 'next_cook' });
  assert.deepStrictEqual(s.lastRenderedView, { surface: 'shopping', view: 'next_cook' });
  assert.equal(s.surfaceContext, 'shopping');
});

test('setLastRenderedView: does not touch other slice fields it does not own', () => {
  const s: NavigationSessionSlice & { lastRecipeSlug?: string; marker?: string } = {
    surfaceContext: null,
    lastRenderedView: undefined,
    lastRecipeSlug: 'keep-me',
    marker: 'untouched',
  };
  setLastRenderedView(s, { surface: 'plan', view: 'next_action' });
  assert.equal(s.lastRecipeSlug, 'keep-me');
  assert.equal(s.marker, 'untouched');
});
