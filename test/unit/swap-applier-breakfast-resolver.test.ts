/**
 * Unit tests for `breakfastMentionsUserIngredient` — breakfast-target
 * ingredient resolver in src/plan/swap-applier.ts.
 *
 * Regression protection for a Codex finding on the
 * plan-033-ingredient-swap branch: named breakfast reversals ("put the
 * yogurt back" after a yogurt → ricotta swap) didn't resolve because
 * the resolver only scanned the current per-day ingredient list, not
 * the breakfast override's swap history. Batches already had this
 * behavior via `batchMentionsUserIngredient`; this restores parity.
 *
 * Per proposal 008 Commitment B.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { breakfastMentionsUserIngredient } from '../../src/plan/swap-applier.js';
import type { PlanSession, Recipe } from '../../src/models/types.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';

function recipe(): Recipe {
  return {
    name: 'Yogurt Granola Bowl',
    slug: 'yogurt-granola-bowl',
    cuisine: 'test',
    tags: [],
    prepTimeMinutes: 0,
    mealTypes: ['breakfast'],
    structure: [{ type: 'breakfast_component', name: 'Bowl' }],
    perServing: { calories: 400, protein: 25, fat: 12, carbs: 50 },
    ingredients: [
      { name: 'greek yogurt', amount: 150, unit: 'g', role: 'protein', component: 'Bowl' },
      { name: 'granola', amount: 40, unit: 'g', role: 'carb', component: 'Bowl' },
      { name: 'berries', amount: 60, unit: 'g', role: 'vegetable', component: 'Bowl' },
    ],
    storage: { fridgeDays: 3, freezable: false, reheat: 'none' },
    body: '',
  };
}

function sessionWithoutOverride(): PlanSession {
  return {
    id: 'sess-breakfast',
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: {
      locked: true,
      recipeSlug: 'yogurt-granola-bowl',
      caloriesPerDay: 400,
      proteinPerDay: 25,
    },
    treatBudgetCalories: 0,
    flexSlots: [],
    events: [],
    mutationHistory: [],
    confirmedAt: '2026-04-05T18:00:00Z',
    superseded: false,
    createdAt: '2026-04-05T18:00:00Z',
    updatedAt: '2026-04-05T18:00:00Z',
  };
}

/**
 * Session with a breakfast override whose swapHistory records a
 * yogurt → ricotta swap. The current ingredients no longer contain
 * yogurt — it lives only in the history's `from` field.
 */
function sessionWithYogurtSwappedOut(): PlanSession {
  const s = sessionWithoutOverride();
  s.breakfastOverride = {
    scaledIngredientsPerDay: [
      { name: 'ricotta', amount: 120, unit: 'g', totalForBatch: 120, role: 'protein' },
      { name: 'granola', amount: 40, unit: 'g', totalForBatch: 40, role: 'carb' },
      { name: 'berries', amount: 60, unit: 'g', totalForBatch: 60, role: 'vegetable' },
    ],
    actualPerDay: { calories: 420, protein: 24, fat: 14, carbs: 48 },
    swapHistory: [
      {
        appliedAt: '2026-04-07T08:00:00.000Z',
        userMessage: 'no yogurt, use ricotta instead',
        changes: [
          {
            kind: 'replace',
            from: 'greek yogurt',
            to: 'ricotta',
            fromAmount: 150,
            fromUnit: 'g',
            toAmount: 120,
            toUnit: 'g',
          },
        ],
        resultingMacros: { calories: 420, protein: 24, fat: 14, carbs: 48 },
      },
    ],
  };
  return s;
}

function recipeDb(r: Recipe): RecipeDatabase {
  return {
    getBySlug: (slug: string) => (slug === r.slug ? r : undefined),
    getAll: () => [r],
  } as unknown as RecipeDatabase;
}

test('breakfastMentionsUserIngredient: matches a current ingredient (yogurt in library)', () => {
  const sess = sessionWithoutOverride();
  const r = recipe();
  assert.equal(
    breakfastMentionsUserIngredient(sess, recipeDb(r), 'no yogurt, use cottage cheese'),
    true,
  );
});

test('breakfastMentionsUserIngredient: matches a current ingredient in the override', () => {
  const sess = sessionWithYogurtSwappedOut();
  const r = recipe();
  // "ricotta" is in the override's scaledIngredientsPerDay
  assert.equal(
    breakfastMentionsUserIngredient(sess, recipeDb(r), 'swap ricotta for cottage cheese'),
    true,
  );
});

test('breakfastMentionsUserIngredient: matches a previously-swapped-out ingredient via swap history', () => {
  // THIS is the regression fix — yogurt is no longer in current
  // ingredients (ricotta replaced it), but "put the yogurt back"
  // should still bind to the breakfast target.
  const sess = sessionWithYogurtSwappedOut();
  const r = recipe();
  assert.equal(
    breakfastMentionsUserIngredient(sess, recipeDb(r), 'put the yogurt back'),
    true,
  );
});

test('breakfastMentionsUserIngredient: matches even when the override references greek-yogurt form', () => {
  // The history stores "greek yogurt"; user typed "yogurt". Token
  // match via `nameAppearsInUser` covers this.
  const sess = sessionWithYogurtSwappedOut();
  const r = recipe();
  assert.equal(
    breakfastMentionsUserIngredient(sess, recipeDb(r), 'undo the yogurt swap'),
    true,
  );
});

test('breakfastMentionsUserIngredient: returns false when the user names an unrelated ingredient', () => {
  const sess = sessionWithoutOverride();
  const r = recipe();
  assert.equal(
    breakfastMentionsUserIngredient(sess, recipeDb(r), 'no chicken in the dinner'),
    false,
  );
});

test('breakfastMentionsUserIngredient: returns false when the recipe cannot be resolved', () => {
  const sess = sessionWithoutOverride();
  // Empty recipe DB — the library fallback fails.
  const emptyDb = { getBySlug: () => undefined, getAll: () => [] } as unknown as RecipeDatabase;
  assert.equal(
    breakfastMentionsUserIngredient(sess, emptyDb, 'no yogurt'),
    false,
  );
});
