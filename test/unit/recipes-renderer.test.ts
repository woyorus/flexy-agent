/**
 * Unit tests for the recipe renderer (`src/recipes/renderer.ts`).
 *
 * Covers placeholder resolution in recipe body text — `{ingredient_name}`
 * tokens must be replaced with formatted amounts when rendered, and
 * unmatched placeholders must pass through unchanged (legacy recipes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRecipe } from '../../src/recipes/renderer.js';
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

// ─── Placeholder resolution ─────────────────────────────────────────────────

test('renderRecipe resolves {ingredient_name} to formatted amount + unit + name', () => {
  const recipe = makeRecipe({ body: 'Heat {olive oil} in a skillet.' });
  const output = renderRecipe(recipe);
  assert.ok(output.includes('15ml olive oil'), `Expected resolved placeholder, got: ${output}`);
  assert.ok(!output.includes('{olive oil}'), 'Raw placeholder should not appear');
});

test('renderRecipe resolves placeholders case-insensitively', () => {
  const recipe = makeRecipe({ body: 'Cook {Penne Pasta} until al dente.' });
  const output = renderRecipe(recipe);
  assert.ok(output.includes('80g penne pasta'), `Expected resolved placeholder, got: ${output}`);
  assert.ok(!output.includes('{Penne Pasta}'), 'Raw placeholder should not appear');
});

test('renderRecipe leaves unmatched placeholders unchanged', () => {
  const recipe = makeRecipe({ body: 'Add {mystery spice} and stir.' });
  const output = renderRecipe(recipe);
  assert.ok(output.includes('{mystery spice}'), 'Unmatched placeholder should pass through');
});

test('renderRecipe scales placeholder amounts when servings provided', () => {
  const recipe = makeRecipe({ body: 'Cook {penne pasta} until al dente.' });
  const output = renderRecipe(recipe, undefined, 3);
  // 80g * 3 = 240g, formatAmount rounds to nearest 5 for >=100
  assert.ok(output.includes('240g penne pasta'), `Expected scaled amount, got: ${output}`);
});

test('renderRecipe body with no placeholders is unchanged', () => {
  const recipe = makeRecipe({ body: 'Just cook everything together.' });
  const output = renderRecipe(recipe);
  assert.ok(output.includes('Just cook everything together.'));
});
