/**
 * Plan 026 — proposal validator invariant #14: batch.mealType ∈ recipe.mealTypes.
 *
 * Ensures the re-proposer (and any future caller of validateProposal) cannot
 * place a recipe into a meal-type lane its author did not permit. A dinner-only
 * tagine in a lunch batch is invalid; a lunch-and-dinner grain bowl in either
 * lane is fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal } from '../../src/qa/validators/proposal.js';
import type { PlanProposal } from '../../src/solver/types.js';
import type { Recipe } from '../../src/models/types.js';

function makeRecipe(slug: string, mealTypes: Recipe['mealTypes']): Recipe {
  return {
    name: slug, shortName: slug, slug, mealTypes,
    cuisine: 'test', tags: [], prepTimeMinutes: 20,
    structure: [{ type: 'main', name: 'Main' }],
    perServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
    ingredients: [{ name: 'p', amount: 150, unit: 'g', role: 'protein', component: 'Main' }],
    storage: { fridgeDays: 4, freezable: true, reheat: '' },
    body: '',
  };
}

function fakeDb(recipes: Recipe[]): import('../../src/recipes/database.js').RecipeDatabase {
  const m = new Map(recipes.map((r) => [r.slug, r]));
  return {
    getBySlug: (slug: string) => m.get(slug),
    getAll: () => [...m.values()],
  } as unknown as import('../../src/recipes/database.js').RecipeDatabase;
}

function proposal(overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    batches: [],
    flexSlots: [{ day: '2026-04-12', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
    ...overrides,
  };
}

const horizonDays = [
  '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
  '2026-04-10', '2026-04-11', '2026-04-12',
];

test('invariant #14: dinner-only recipe in a lunch batch → error', () => {
  const db = fakeDb([makeRecipe('tagine', ['dinner'])]);
  const p = proposal({
    batches: [
      {
        recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch',
        days: ['2026-04-06', '2026-04-07'], servings: 2,
      },
    ],
  });
  const result = validateProposal(p, db, horizonDays, []);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.startsWith('#14')),
    `expected a #14 error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('invariant #14: recipe permits both lunch and dinner → no lane error', () => {
  const db = fakeDb([makeRecipe('grain-bowl', ['lunch', 'dinner'])]);
  const p = proposal({
    batches: [
      {
        recipeSlug: 'grain-bowl', recipeName: 'Grain Bowl', mealType: 'lunch',
        days: ['2026-04-06', '2026-04-07'], servings: 2,
      },
      {
        recipeSlug: 'grain-bowl', recipeName: 'Grain Bowl', mealType: 'dinner',
        days: ['2026-04-06', '2026-04-07'], servings: 2,
      },
    ],
  });
  const result = validateProposal(p, db, horizonDays, []);
  assert.ok(
    !result.errors.some((e) => e.startsWith('#14')),
    `expected no #14 error, got: ${JSON.stringify(result.errors)}`,
  );
});

test('invariant #14: missing recipe is caught by #10, not #14', () => {
  const db = fakeDb([]); // no recipes
  const p = proposal({
    batches: [
      {
        recipeSlug: 'ghost', recipeName: 'Ghost', mealType: 'lunch',
        days: ['2026-04-06'], servings: 1,
      },
    ],
  });
  const result = validateProposal(p, db, horizonDays, []);
  assert.ok(
    result.errors.some((e) => e.startsWith('#10')),
    '#10 should fire for missing recipes',
  );
  assert.ok(
    !result.errors.some((e) => e.startsWith('#14')),
    '#14 must not double-report on missing recipes',
  );
});
