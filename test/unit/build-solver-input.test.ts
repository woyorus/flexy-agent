/**
 * Regression test for Plan 010: buildSolverInput must pass in-horizon
 * eating occasions to the solver, not total servings (which includes overflow).
 *
 * The regression site is the mapping in plan-flow.ts — a solver-only test with
 * correct input would stay green even if the leak returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSolverInput } from '../../src/agents/plan-flow.js';
import type { PlanFlowState } from '../../src/agents/plan-flow.js';
import type { PlanProposal } from '../../src/solver/types.js';

const HORIZON = [
  '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16',
  '2026-04-17', '2026-04-18', '2026-04-19',
];

test('buildSolverInput: overflow batch emits servings === days.length, not total servings', () => {
  const state: PlanFlowState = {
    phase: 'confirmed',
    weekStart: '2026-04-13',
    weekDays: HORIZON,
    breakfast: { recipeSlug: 'b', name: 'Breakfast', caloriesPerDay: 650, proteinPerDay: 40 },
    events: [],
    horizonDays: HORIZON,
  };

  const proposal: PlanProposal = {
    batches: [
      {
        recipeSlug: 'moroccan-beef',
        recipeName: 'Moroccan Beef',
        mealType: 'dinner',
        days: [HORIZON[6]!],            // 1 in-horizon day (Sun)
        servings: 3,                    // total including 2 overflow
        overflowDays: ['2026-04-20', '2026-04-21'],
      },
      {
        recipeSlug: 'chicken-stir-fry',
        recipeName: 'Chicken Stir-Fry',
        mealType: 'lunch',
        days: [HORIZON[2]!, HORIZON[3]!, HORIZON[4]!],
        servings: 3,                    // no overflow — servings matches days
      },
    ],
    flexSlots: [],
    recipesToGenerate: [],
  };

  const input = buildSolverInput(state, proposal);

  const moroccan = input.mealPrepPreferences.recipes.find(
    (r) => r.recipeSlug === 'moroccan-beef',
  )!;
  assert.ok(moroccan, 'moroccan-beef batch should be in solver input');
  assert.equal(
    moroccan.servings, 1,
    'overflow batch: solver should see 1 serving (days.length), not 3 (total)',
  );

  const chicken = input.mealPrepPreferences.recipes.find(
    (r) => r.recipeSlug === 'chicken-stir-fry',
  )!;
  assert.ok(chicken, 'chicken-stir-fry batch should be in solver input');
  assert.equal(
    chicken.servings, 3,
    'non-overflow batch: servings should equal days.length (3)',
  );
});
