/**
 * Unit tests for Plan 030's new shopping generator scope functions.
 *
 * Covers:
 *   - full_week aggregation across multiple cook days
 *   - full_week breakfast proration to horizon length
 *   - recipe-scoped filtering (single batch, multi-batch aggregation)
 *   - recipe-scoped omits breakfast
 *   - day-scoped matches generateShoppingList behavior
 *   - empty-scope graceful handling
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  generateShoppingList,
  generateShoppingListForWeek,
  generateShoppingListForRecipe,
  generateShoppingListForDay,
} from '../../src/shopping/generator.js';
import type { Batch, Recipe, PlanSession } from '../../src/models/types.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';

/**
 * Plan 033: the shopping generators now take `PlanSession | undefined` +
 * `RecipeDatabase` instead of `Recipe | undefined`. These helpers wrap the
 * test-only pattern: build a minimal session pointing at the breakfast
 * recipe's slug and a one-entry recipe DB.
 */
function sessionForBreakfast(recipe: Recipe): PlanSession {
  return {
    id: 'sess-1',
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: {
      locked: true,
      recipeSlug: recipe.slug,
      caloriesPerDay: recipe.perServing.calories,
      proteinPerDay: recipe.perServing.protein,
    },
    treatBudgetCalories: 0,
    flexSlots: [],
    events: [],
    mutationHistory: [],
    confirmedAt: '2026-04-01T00:00:00Z',
    superseded: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  };
}

function recipesDbFor(recipe: Recipe): RecipeDatabase {
  return {
    getBySlug: (slug: string) => (slug === recipe.slug ? recipe : undefined),
    getAll: () => [recipe],
  } as unknown as RecipeDatabase;
}

function batch(
  id: string,
  slug: string,
  cookDay: string,
  ingredients: Array<{ name: string; amount: number; unit: string; role: 'protein' | 'carb' | 'vegetable' | 'fat' | 'base' | 'seasoning' }>,
): Batch {
  return {
    id,
    recipeSlug: slug,
    mealType: 'dinner',
    eatingDays: [cookDay],
    servings: 2,
    targetPerServing: { calories: 800, protein: 45 },
    actualPerServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
    scaledIngredients: ingredients.map((i) => ({ ...i, totalForBatch: i.amount })),
    status: 'planned',
    createdInPlanSessionId: 'sess-1',
  };
}

function recipeWithIngredients(
  slug: string,
  ingredients: Array<{ name: string; amount: number; unit: string; role: 'protein' | 'carb' | 'vegetable' | 'fat' | 'base' | 'seasoning' }>,
): Recipe {
  return {
    name: slug,
    slug,
    cuisine: 'test',
    tags: [],
    prepTimeMinutes: 0,
    structure: [{ type: 'main', name: 'Main' }],
    perServing: { calories: 400, protein: 15, fat: 10, carbs: 50 },
    ingredients: ingredients.map((i) => ({ ...i, component: 'Main' })),
    storage: { fridgeDays: 3, freezable: false, reheat: 'microwave' },
    mealTypes: ['breakfast'],
    body: '',
  } as Recipe;
}

test('generateShoppingListForWeek: aggregates across multiple cook days', () => {
  const batches = [
    batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }]),
    batch('b2', 'grain-bowl', '2026-04-09', [{ name: 'quinoa', amount: 300, unit: 'g', role: 'carb' }]),
    batch('b3', 'tagine', '2026-04-10', [{ name: 'beef', amount: 200, unit: 'g', role: 'protein' }]),
  ];
  const list = generateShoppingListForWeek(batches, undefined, undefined, {
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
  });
  // Beef from b1 + b3 aggregated to 600g.
  const meatCategory = list.categories.find((c) => c.name === 'MEAT');
  assert.ok(meatCategory, 'MEAT category should exist');
  const beef = meatCategory!.items.find((i) => i.name === 'beef');
  assert.ok(beef, 'beef should be aggregated');
  assert.equal(beef!.amount, 600);
});

test('generateShoppingListForWeek: prorates breakfast to horizon length', () => {
  const batches = [batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }])];
  const breakfast = recipeWithIngredients('oatmeal', [{ name: 'oats', amount: 50, unit: 'g', role: 'carb' }]);
  const list = generateShoppingListForWeek(batches, sessionForBreakfast(breakfast), recipesDbFor(breakfast), {
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
  });
  // 7 days * 50g = 350g oats.
  const pantry = list.categories.find((c) => c.name === 'PANTRY');
  assert.ok(pantry, 'PANTRY category should exist');
  const oats = pantry!.items.find((i) => i.name === 'oats');
  assert.ok(oats, 'oats should be in pantry');
  assert.equal(oats!.amount, 350);
});

test('generateShoppingListForRecipe: filters to single slug', () => {
  const batches = [
    batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }]),
    batch('b2', 'grain-bowl', '2026-04-09', [{ name: 'quinoa', amount: 300, unit: 'g', role: 'carb' }]),
  ];
  const list = generateShoppingListForRecipe(batches, { recipeSlug: 'tagine' });
  // Only tagine's beef — no quinoa.
  const meat = list.categories.find((c) => c.name === 'MEAT');
  assert.ok(meat);
  assert.equal(meat!.items.length, 1);
  assert.equal(meat!.items[0]!.name, 'beef');
  const pantry = list.categories.find((c) => c.name === 'PANTRY');
  assert.equal(pantry, undefined, 'quinoa should not appear');
});

test('generateShoppingListForRecipe: aggregates multi-batch', () => {
  const batches = [
    batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }]),
    batch('b2', 'tagine', '2026-04-10', [{ name: 'beef', amount: 200, unit: 'g', role: 'protein' }]),
  ];
  const list = generateShoppingListForRecipe(batches, { recipeSlug: 'tagine' });
  const beef = list.categories.find((c) => c.name === 'MEAT')!.items[0]!;
  assert.equal(beef.amount, 600);
});

test('generateShoppingListForRecipe: omits breakfast (no breakfast param)', () => {
  const batches = [batch('b1', 'tagine', '2026-04-06', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }])];
  const list = generateShoppingListForRecipe(batches, { recipeSlug: 'tagine' });
  const allItems = list.categories.flatMap((c) => c.items);
  assert.equal(allItems.find((i) => i.name === 'oats'), undefined);
});

test('generateShoppingListForDay: matches generateShoppingList output', () => {
  const batches = [batch('b1', 'tagine', '2026-04-09', [{ name: 'beef', amount: 400, unit: 'g', role: 'protein' }])];
  const breakfast = recipeWithIngredients('oatmeal', [{ name: 'oats', amount: 50, unit: 'g', role: 'carb' }]);
  const session = sessionForBreakfast(breakfast);
  const recipes = recipesDbFor(breakfast);
  const a = generateShoppingList(batches, session, recipes, { targetDate: '2026-04-09', remainingDays: 4 });
  const b = generateShoppingListForDay(batches, session, recipes, { day: '2026-04-09', remainingDays: 4 });
  assert.deepStrictEqual(a, b);
});

test('generateShoppingListForWeek: empty batches produces empty list', () => {
  const list = generateShoppingListForWeek([], undefined, undefined, { horizonStart: '2026-04-06', horizonEnd: '2026-04-12' });
  assert.deepStrictEqual(list.categories, []);
  assert.deepStrictEqual(list.checkYouHave, []);
});
