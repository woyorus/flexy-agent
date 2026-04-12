/**
 * Unit tests for buildDispatcherContext — Plan 028 Task 8.
 *
 * Exercises the context builder against hand-constructed slices:
 *
 *   - no plan + no active flow → lifecycle=no_plan, planSummary=null, activeFlow.kind=none
 *   - recipeFlow reviewing → activeFlow.kind=recipe (recipe wins over plan per preference order)
 *   - pendingClarification carries through on the active flow summary
 *   - recent turns pass through (minus timestamps)
 *   - recipe index is built correctly from recipes.getAll()
 *   - allowedActions is the v0.0.5 minimal set
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildDispatcherContext,
  pushTurn,
  type DispatcherSession,
} from '../../src/telegram/dispatcher-runner.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';
import type { Recipe } from '../../src/models/types.js';
import type { StateStoreLike } from '../../src/state/store.js';

function makeSession(overrides: Partial<DispatcherSession> = {}): DispatcherSession {
  return {
    recipeFlow: null,
    planFlow: null,
    progressFlow: null,
    surfaceContext: null,
    ...overrides,
  };
}

function fakeRecipe(slug: string, overrides: Partial<Recipe> = {}): Recipe {
  return {
    slug,
    name: `${slug} name`,
    shortName: slug,
    mealTypes: ['dinner'],
    cuisine: 'global',
    tags: [],
    prepTimeMinutes: 30,
    structure: [],
    perServing: { calories: 600, protein: 40, fat: 20, carbs: 60 },
    ingredients: [],
    storage: { fridgeDays: 4, freezable: true, reheat: 'microwave 2 min' },
    body: '',
    ...overrides,
  };
}

function fakeRecipeDb(recipes: Recipe[]): RecipeDatabase {
  return {
    getAll: () => recipes,
    getBySlug: (slug: string) => recipes.find((r) => r.slug === slug),
  } as unknown as RecipeDatabase;
}

function fakeStore(): StateStoreLike {
  return {
    getRunningPlanSession: async () => null,
    getFuturePlanSessions: async () => [],
    getBatchesByPlanSessionId: async () => [],
    getLatestMeasurement: async () => null,
    getMeasurements: async () => [],
    logMeasurement: async () => {},
  } as unknown as StateStoreLike;
}

test('buildDispatcherContext: no plan + no flow', async () => {
  const ctx = await buildDispatcherContext(
    makeSession(),
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.lifecycle, 'no_plan');
  assert.equal(ctx.planSummary, null);
  assert.deepStrictEqual(ctx.activeFlow, { kind: 'none' });
  assert.deepStrictEqual(ctx.recipeIndex, []);
  assert.equal(ctx.today, '2026-04-10');
});

test('buildDispatcherContext: recipeFlow reviewing beats planFlow', async () => {
  const session = makeSession({
    planFlow: { phase: 'proposal' },
    recipeFlow: { phase: 'reviewing' },
  });
  const ctx = await buildDispatcherContext(
    session,
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.activeFlow.kind, 'recipe');
});

test('buildDispatcherContext: planFlow pending clarification is preserved', async () => {
  const session = makeSession({
    planFlow: {
      phase: 'proposal',
      weekStart: '2026-04-06',
      weekDays: ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'],
      pendingClarification: {
        question: 'Lunch or dinner?',
        originalMessage: 'I went to the Indian place',
      },
    },
  });
  const ctx = await buildDispatcherContext(
    session,
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.activeFlow.kind, 'plan');
  if (ctx.activeFlow.kind === 'plan') {
    assert.deepStrictEqual(ctx.activeFlow.pendingClarification, {
      question: 'Lunch or dinner?',
      originalMessage: 'I went to the Indian place',
    });
  }
});

test('buildDispatcherContext: recipe index is built from getAll', async () => {
  const recipes = [
    fakeRecipe('moroccan-tagine', { cuisine: 'moroccan' }),
    fakeRecipe('chicken-pepperonata', { cuisine: 'italian' }),
  ];
  const ctx = await buildDispatcherContext(
    makeSession(),
    fakeStore(),
    fakeRecipeDb(recipes),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.recipeIndex.length, 2);
  assert.equal(ctx.recipeIndex[0]!.slug, 'moroccan-tagine');
  assert.equal(ctx.recipeIndex[0]!.cuisine, 'moroccan');
  assert.equal(ctx.recipeIndex[1]!.cuisine, 'italian');
});

test('buildDispatcherContext: recent turns pass through', async () => {
  const session = makeSession();
  pushTurn(session, 'user', 'hello');
  pushTurn(session, 'bot', 'hi');
  pushTurn(session, 'user', 'how much protein in chicken');

  const ctx = await buildDispatcherContext(
    session,
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.equal(ctx.recentTurns.length, 3);
  assert.equal(ctx.recentTurns[0]!.text, 'hello');
  assert.equal(ctx.recentTurns[2]!.text, 'how much protein in chicken');
});

test('buildDispatcherContext: allowedActions is the v0.0.5 minimal set', async () => {
  const ctx = await buildDispatcherContext(
    makeSession(),
    fakeStore(),
    fakeRecipeDb([]),
    new Date('2026-04-10T12:00:00Z'),
  );
  assert.deepStrictEqual(Array.from(ctx.allowedActions), [
    'flow_input',
    'clarify',
    'out_of_scope',
    'return_to_flow',
    'mutate_plan',
  ]);
});
