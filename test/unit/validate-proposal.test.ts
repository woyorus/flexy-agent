/**
 * Unit tests for validateProposal() — Plan 024 proposal validator.
 *
 * Tests all 13 invariants from the plan, plus baseline and edge cases
 * for non-consecutive batches and fridge-life constraints.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal } from '../../src/qa/validators/proposal.js';
import type { PlanProposal, ProposedBatch, PreCommittedSlot } from '../../src/solver/types.js';
import type { FlexSlot, MealEvent, Recipe } from '../../src/models/types.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const HORIZON = [
  '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16',
  '2026-04-17', '2026-04-18', '2026-04-19',
];

/** Minimal recipe stub with configurable fridgeDays. */
function makeRecipe(slug: string, fridgeDays = 5): Partial<Recipe> {
  // Plan 026 invariant #14 reads recipe.mealTypes — default to both lanes so
  // existing tests aren't constrained by lane mismatches they don't care about.
  return {
    slug,
    mealTypes: ['lunch', 'dinner'],
    storage: { fridgeDays, freezable: false, reheat: 'microwave' },
  };
}

/** Mock RecipeDatabase that resolves slugs from a provided map. */
function mockDb(recipes: Record<string, Partial<Recipe>>): RecipeDatabase {
  return {
    getBySlug(slug: string) {
      return recipes[slug] as Recipe | undefined;
    },
  } as RecipeDatabase;
}

/**
 * Build a valid baseline proposal covering the full 7-day horizon.
 * 5 lunch batches (2+3 servings) + 5 dinner batches (2+3 servings) + 1 flex slot (lunch) + 1 flex slot (dinner).
 * Wait — we have 7 days × 2 meals = 14 slots. With 1 flex slot, we need 13 batch slots.
 * Let's use: 4 lunch batches (3+3+3+3=12 too many) — actually let me think carefully.
 *
 * 7 days × lunch = 7 slots. 1 flex → 6 meal-prep lunch slots. 2 batches (3+3).
 * 7 days × dinner = 7 slots. 0 flex → 7 meal-prep dinner slots. 3 batches (3+2+2).
 * Flex on Monday lunch.
 */
function validBaseline(): { proposal: PlanProposal; db: RecipeDatabase } {
  const recipes = {
    'chicken-stir-fry': makeRecipe('chicken-stir-fry', 5),
    'beef-bowl': makeRecipe('beef-bowl', 5),
    'salmon-pasta': makeRecipe('salmon-pasta', 4),
    'veggie-curry': makeRecipe('veggie-curry', 5),
    'pork-tacos': makeRecipe('pork-tacos', 4),
  };

  const batches: ProposedBatch[] = [
    // Lunch batches: Mon flex, so Tue-Thu + Fri-Sun
    { recipeSlug: 'chicken-stir-fry', recipeName: 'Chicken Stir-Fry', mealType: 'lunch',
      days: ['2026-04-14', '2026-04-15', '2026-04-16'], servings: 3 },
    { recipeSlug: 'beef-bowl', recipeName: 'Beef Bowl', mealType: 'lunch',
      days: ['2026-04-17', '2026-04-18', '2026-04-19'], servings: 3 },
    // Dinner batches: Mon-Tue-Wed + Thu-Fri + Sat-Sun
    { recipeSlug: 'salmon-pasta', recipeName: 'Salmon Pasta', mealType: 'dinner',
      days: ['2026-04-13', '2026-04-14', '2026-04-15'], servings: 3 },
    { recipeSlug: 'veggie-curry', recipeName: 'Veggie Curry', mealType: 'dinner',
      days: ['2026-04-16', '2026-04-17'], servings: 2 },
    { recipeSlug: 'pork-tacos', recipeName: 'Pork Tacos', mealType: 'dinner',
      days: ['2026-04-18', '2026-04-19'], servings: 2 },
  ];

  const flexSlots: FlexSlot[] = [
    { day: '2026-04-13', mealTime: 'lunch', flexBonus: 350, note: 'flex lunch' },
  ];

  const proposal: PlanProposal = {
    batches,
    flexSlots,
    events: [],
    recipesToGenerate: [],
  };

  return { proposal, db: mockDb(recipes) };
}

// ─── Baseline ───────────────────────────────────────────────────────────────

test('validateProposal: valid baseline passes all checks', () => {
  const { proposal, db } = validBaseline();
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join('; ')}`);
  assert.equal(result.errors.length, 0);
});

// ─── Invariant 1: Slot coverage ────────────────────────────────────────────

test('#1 Slot coverage: uncovered slot detected', () => {
  const { proposal, db } = validBaseline();
  // Remove the first lunch batch, leaving Tue-Thu lunch uncovered
  proposal.batches = proposal.batches.filter((b) => b.recipeSlug !== 'chicken-stir-fry');
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#1') && e.includes('2026-04-14') && e.includes('lunch')));
});

// ─── Invariant 2: No overlap ───────────────────────────────────────────────

test('#2 Overlap: two sources on same slot detected', () => {
  const { proposal, db } = validBaseline();
  // Add an event that overlaps with the flex slot on Mon lunch
  proposal.events.push({
    name: 'Work lunch', day: '2026-04-13', mealTime: 'lunch',
    estimatedCalories: 600,
  });
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#2') && e.includes('2026-04-13:lunch')));
});

// ─── Invariant 3: Eating days sorted ───────────────────────────────────────

test('#3 Sort: unsorted days detected', () => {
  const { proposal, db } = validBaseline();
  proposal.batches[0]!.days = ['2026-04-16', '2026-04-14', '2026-04-15'];
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#3')));
});

// ─── Invariant 4: Servings match ───────────────────────────────────────────

test('#4 Servings: mismatch detected', () => {
  const { proposal, db } = validBaseline();
  proposal.batches[0]!.servings = 2; // 3 days but servings=2
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#4')));
});

// ─── Invariant 5: Servings range ───────────────────────────────────────────

test('#5 Range: 0 servings is error', () => {
  const { proposal, db } = validBaseline();
  proposal.batches[0]!.servings = 0;
  proposal.batches[0]!.days = [];
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  // Also triggers slot coverage, but we check range specifically
  assert.ok(result.errors.some((e) => e.includes('#5')));
});

test('#5 Range: 1-serving batch is warning', () => {
  const { proposal, db } = validBaseline();
  // Make the first lunch batch 1-serving on just one day
  proposal.batches[0]!.days = ['2026-04-14'];
  proposal.batches[0]!.servings = 1;
  // Add a new batch to cover the uncovered days
  proposal.batches.push({
    recipeSlug: 'chicken-stir-fry', recipeName: 'Chicken Stir-Fry', mealType: 'lunch',
    days: ['2026-04-15', '2026-04-16'], servings: 2,
  });
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join('; ')}`);
  assert.ok(result.warnings.some((w) => w.includes('#5') && w.includes('1-serving')));
});

// ─── Invariant 6: Cook day in horizon ──────────────────────────────────────

test('#6 Cook day: out-of-horizon cook day detected', () => {
  const { proposal, db } = validBaseline();
  proposal.batches[0]!.days[0] = '2026-04-12'; // Before horizon
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#6')));
});

// ─── Invariant 7: Fridge life respected ────────────────────────────────────

test('#7 Fridge life: span exceeding fridgeDays detected', () => {
  const recipes = {
    'short-life': makeRecipe('short-life', 2), // Only 2 fridge days
  };
  const proposal: PlanProposal = {
    batches: [
      { recipeSlug: 'short-life', recipeName: 'Short Life', mealType: 'lunch',
        days: ['2026-04-13', '2026-04-14', '2026-04-15'], servings: 3 },
    ],
    flexSlots: [{ day: '2026-04-13', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
  };
  // Only test invariant 7 — incomplete coverage is expected
  const result = validateProposal(proposal, mockDb(recipes), HORIZON, []);
  assert.ok(result.errors.some((e) => e.includes('#7') && e.includes('short-life')));
});

// ─── Invariant 8: Flex count ───────────────────────────────────────────────

test('#8 Flex count: wrong number detected', () => {
  const { proposal, db } = validBaseline();
  // Add extra flex slot
  proposal.flexSlots.push({ day: '2026-04-19', mealTime: 'dinner', flexBonus: 350 });
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#8')));
});

// ─── Invariant 9: Pre-committed slots intact ───────────────────────────────

test('#9 Pre-committed: missing pre-committed slot detected', () => {
  const { proposal, db } = validBaseline();
  const preCommitted: PreCommittedSlot[] = [
    { day: '2026-04-15', mealTime: 'lunch', recipeSlug: 'old-recipe', calories: 600, protein: 40, sourceBatchId: 'x' },
  ];
  const result = validateProposal(proposal, db, HORIZON, preCommitted);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#9')));
});

// ─── Invariant 10: Recipes exist ───────────────────────────────────────────

test('#10 Recipe missing: non-existent slug detected', () => {
  const { proposal, db } = validBaseline();
  proposal.batches[0]!.recipeSlug = 'ghost-recipe';
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes('#10') && e.includes('ghost-recipe')));
});

// ─── Invariant 11: Event dates in horizon ──────────────────────────────────

test('#11 Event date: out-of-horizon event detected', () => {
  const { proposal, db } = validBaseline();
  // Remove flex slot and add event instead on Mon lunch (so no overlap)
  proposal.flexSlots = [];
  proposal.events.push({
    name: 'Birthday', day: '2026-04-25', mealTime: 'lunch',
    estimatedCalories: 800,
  });
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(result.errors.some((e) => e.includes('#11') && e.includes('Birthday')));
});

// ─── Invariant 12: Event fields valid ──────────────────────────────────────

test('#12 Event fields: empty name and non-positive calories detected', () => {
  const { proposal, db } = validBaseline();
  // Replace flex with an event that has invalid fields
  proposal.flexSlots = [];
  proposal.events.push({
    name: '', day: '2026-04-13', mealTime: 'lunch',
    estimatedCalories: 0,
  });
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(result.errors.some((e) => e.includes('#12') && e.includes('empty name')));
  assert.ok(result.errors.some((e) => e.includes('#12') && e.includes('non-positive')));
});

// ─── Invariant 13: No duplicate events ─────────────────────────────────────

test('#13 Duplicate events: same (day, mealTime) detected', () => {
  const { proposal, db } = validBaseline();
  // Remove flex, remove Mon lunch batch coverage, add two events on same slot
  proposal.flexSlots = [];
  proposal.events.push(
    { name: 'Lunch A', day: '2026-04-13', mealTime: 'lunch', estimatedCalories: 500 },
    { name: 'Lunch B', day: '2026-04-13', mealTime: 'lunch', estimatedCalories: 600 },
  );
  const result = validateProposal(proposal, db, HORIZON, []);
  assert.ok(result.errors.some((e) => e.includes('#13')));
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('Non-consecutive batch within fridge-life passes', () => {
  const recipes = {
    'chicken-stir-fry': makeRecipe('chicken-stir-fry', 5),
    'beef-bowl': makeRecipe('beef-bowl', 5),
    'salmon-pasta': makeRecipe('salmon-pasta', 5),
    'veggie-curry': makeRecipe('veggie-curry', 5),
    'pork-tacos': makeRecipe('pork-tacos', 5),
  };

  // Non-consecutive lunch batch: Wed, Fri, Sat (skipping Thu)
  const batches: ProposedBatch[] = [
    { recipeSlug: 'chicken-stir-fry', recipeName: 'Chicken Stir-Fry', mealType: 'lunch',
      days: ['2026-04-15', '2026-04-17', '2026-04-18'], servings: 3 }, // Wed, Fri, Sat — spans 4 days, fridgeDays=5 OK
    { recipeSlug: 'beef-bowl', recipeName: 'Beef Bowl', mealType: 'lunch',
      days: ['2026-04-13', '2026-04-14'], servings: 2 }, // Mon-Tue
    { recipeSlug: 'salmon-pasta', recipeName: 'Salmon Pasta', mealType: 'lunch',
      days: ['2026-04-19'], servings: 1 }, // Sun
    // Thu lunch is an event
    // Dinner batches
    { recipeSlug: 'veggie-curry', recipeName: 'Veggie Curry', mealType: 'dinner',
      days: ['2026-04-13', '2026-04-14', '2026-04-15'], servings: 3 },
    { recipeSlug: 'pork-tacos', recipeName: 'Pork Tacos', mealType: 'dinner',
      days: ['2026-04-17', '2026-04-18', '2026-04-19'], servings: 3 },
  ];

  const proposal: PlanProposal = {
    batches,
    flexSlots: [{ day: '2026-04-16', mealTime: 'dinner', flexBonus: 350 }],
    events: [
      { name: 'Team dinner', day: '2026-04-16', mealTime: 'lunch', estimatedCalories: 700 },
    ],
    recipesToGenerate: [],
  };

  const result = validateProposal(proposal, mockDb(recipes), HORIZON, []);
  assert.ok(result.valid, `Expected valid, got errors: ${result.errors.join('; ')}`);
  assert.ok(result.warnings.some((w) => w.includes('1-serving'))); // Sun lunch is 1-serving
});

test('Non-consecutive batch violating fridge-life caught by #7', () => {
  const recipes = {
    'short-life': makeRecipe('short-life', 3), // 3 fridge days
  };

  // Mon, Thu, Fri — spans 5 days but fridgeDays=3
  const proposal: PlanProposal = {
    batches: [
      { recipeSlug: 'short-life', recipeName: 'Short Life', mealType: 'lunch',
        days: ['2026-04-13', '2026-04-16', '2026-04-17'], servings: 3 },
    ],
    flexSlots: [{ day: '2026-04-13', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
  };

  const result = validateProposal(proposal, mockDb(recipes), HORIZON, []);
  assert.ok(result.errors.some((e) => e.includes('#7') && e.includes('short-life') && e.includes('spans 5')));
});
