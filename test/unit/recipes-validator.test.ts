/**
 * Unit tests for the recipe QA validator (`src/qa/validators/recipe.ts`).
 *
 * Covers the placeholder validation (body `{ingredient_name}` placeholders must
 * match ingredient names) and `shortName` validation rules added in Plan 014.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe } from '../../src/qa/validators/recipe.js';
import type { Recipe } from '../../src/models/types.js';

/** Minimal valid Recipe for testing — override fields as needed. */
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: 'Test Recipe',
    slug: 'test-recipe',
    mealTypes: ['dinner'],
    cuisine: 'Italian',
    tags: [],
    prepTimeMinutes: 45,
    structure: [{ type: 'main', name: 'Main' }],
    perServing: { calories: 800, protein: 50, fat: 30, carbs: 75 },
    // 4*50 + 9*30 + 4*75 = 200 + 270 + 300 = 770 — close enough for ±5%
    ingredients: [
      { name: 'olive oil', amount: 15, unit: 'ml', role: 'fat', component: 'Main' },
      { name: 'chicken breast', amount: 200, unit: 'g', role: 'protein', component: 'Main' },
      { name: 'penne pasta', amount: 80, unit: 'g', role: 'carb', component: 'Main' },
    ],
    storage: { fridgeDays: 3, freezable: true, reheat: 'Microwave 2 min' },
    body: 'A simple test recipe.\n\n1. Cook the pasta.\n2. Grill the chicken.',
    ...overrides,
  };
}

// ─── Placeholder validation ─────────────────────────────────────────────────

test('validateRecipe: valid {olive oil} placeholder → no placeholder error', () => {
  const recipe = makeRecipe({ body: 'Heat {olive oil} in a skillet.' });
  const result = validateRecipe(recipe);
  assert.ok(!result.errors.some((e) => e.includes('Placeholder')));
});

test('validateRecipe: {nonexistent} placeholder → error', () => {
  const recipe = makeRecipe({ body: 'Heat {nonexistent} in a skillet.' });
  const result = validateRecipe(recipe);
  assert.ok(result.errors.some((e) => e.includes('{nonexistent}')));
});

test('validateRecipe: case-insensitive placeholder match → no error', () => {
  const recipe = makeRecipe({ body: 'Heat {Olive Oil} in a skillet.' });
  const result = validateRecipe(recipe);
  assert.ok(!result.errors.some((e) => e.includes('Placeholder')));
});

test('validateRecipe: multiple placeholders, one invalid → one error', () => {
  const recipe = makeRecipe({ body: 'Cook {penne pasta} with {butter}.' });
  const result = validateRecipe(recipe);
  assert.ok(!result.errors.some((e) => e.includes('{penne pasta}')));
  assert.ok(result.errors.some((e) => e.includes('{butter}')));
});

// ─── shortName validation ───────────────────────────────────────────────────

test('validateRecipe: shortName > 25 chars → error', () => {
  const recipe = makeRecipe({ shortName: 'A'.repeat(26) });
  const result = validateRecipe(recipe);
  assert.ok(result.errors.some((e) => e.includes('exceeds 25')));
});

test('validateRecipe: missing shortName → warning, not error', () => {
  const recipe = makeRecipe({ shortName: undefined });
  const result = validateRecipe(recipe);
  assert.ok(result.warnings.some((w) => w.includes('short_name')));
  assert.ok(!result.errors.some((e) => e.includes('short_name')));
});

test('validateRecipe: valid shortName → no error or warning about short_name', () => {
  const recipe = makeRecipe({ shortName: 'Test Recipe' });
  const result = validateRecipe(recipe);
  assert.ok(!result.errors.some((e) => e.includes('short_name')));
  assert.ok(!result.warnings.some((w) => w.includes('short_name')));
});
