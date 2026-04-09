/**
 * Unit test for Plan 009 — flex_move overflow rejection + full state rollback.
 *
 * Constructs a PlanFlowState where a flex_move would strand overflow orphans
 * past the horizon end with no adjacent batch to absorb them. Verifies:
 * - Rejection text is returned
 * - proposal, pendingGaps, activeGapIndex, and phase are ALL unchanged
 *
 * This edge case is hard to trigger through the scenario harness because the
 * proposer rarely creates 1-in-horizon + overflow batches, so we test it as
 * a focused unit test with a mock LLM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSwapText, type PlanFlowState } from '../../src/agents/plan-flow.js';
import type { LLMProvider } from '../../src/ai/provider.js';
import type { PlanProposal, ProposedBatch } from '../../src/solver/types.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';
import type { StateStoreLike } from '../../src/state/store.js';

/**
 * Mock LLM that returns a flex_move intent: move flex from Sat dinner to Sun dinner.
 */
function makeMockLLM(toDay: string, toMealTime: string): LLMProvider {
  return {
    complete: async () => ({
      content: JSON.stringify({
        type: 'flex_move',
        to_day: toDay,
        to_meal_time: toMealTime,
        from_day: null,
        from_meal_time: null,
      }),
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    transcribe: async () => { throw new Error('not implemented'); },
  } as LLMProvider;
}

/** Minimal mock RecipeDatabase — not used in this test path. */
const mockRecipeDb = {} as RecipeDatabase;

/** Minimal mock StateStore — not used in this test path. */
const mockStore = {} as StateStoreLike;

/**
 * Build a PlanFlowState with a dinner batch at the horizon edge that has
 * overflow days. Moving flex to that batch's cook day strands the overflow.
 *
 * Layout (horizon Apr 13-19):
 *   Dinner Mon+Tue (2s) — recipe D
 *   Dinner Wed-Thu-Fri (3s, at cap) — recipe E
 *   Flex Sat dinner
 *   Dinner Sun + Mon+Tue overflow (days: [Sun], overflow: [Mon, Tue], 3s) — recipe F
 *
 * Moving flex from Sat to Sun:
 *   - removeBatchDay(Sun) → D30 violation (only in-horizon day removed)
 *   - overflowOrphanDays = [Mon, Tue]
 *   - Mon can't absorb: prev=Sun (now flex), no batch ending on Sat (flex freed it)
 *   - Rejection triggers, full state rolled back
 */
function makeTestState(): PlanFlowState {
  const horizonStart = '2026-04-13';
  const horizonDays = [
    '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16',
    '2026-04-17', '2026-04-18', '2026-04-19',
  ];

  const batches: ProposedBatch[] = [
    // Lunch batches (not affected by the dinner flex_move)
    {
      recipeSlug: 'recipe-lunch-a',
      recipeName: 'Lunch A',
      mealType: 'lunch',
      days: ['2026-04-13', '2026-04-14', '2026-04-15'],
      servings: 3,
    },
    {
      recipeSlug: 'recipe-lunch-b',
      recipeName: 'Lunch B',
      mealType: 'lunch',
      days: ['2026-04-16', '2026-04-17'],
      servings: 2,
    },
    {
      recipeSlug: 'recipe-lunch-c',
      recipeName: 'Lunch C',
      mealType: 'lunch',
      days: ['2026-04-18', '2026-04-19'],
      servings: 2,
    },
    // Dinner batches
    {
      recipeSlug: 'recipe-dinner-d',
      recipeName: 'Dinner D',
      mealType: 'dinner',
      days: ['2026-04-13', '2026-04-14'],
      servings: 2,
    },
    {
      recipeSlug: 'recipe-dinner-e',
      recipeName: 'Dinner E',
      mealType: 'dinner',
      days: ['2026-04-15', '2026-04-16', '2026-04-17'],
      servings: 3,
    },
    // KEY: 1 in-horizon day + 2 overflow → moving flex here triggers D30 violation
    {
      recipeSlug: 'recipe-dinner-f',
      recipeName: 'Dinner F',
      mealType: 'dinner',
      days: ['2026-04-19'],
      overflowDays: ['2026-04-20', '2026-04-21'],
      servings: 3,
    },
  ];

  const proposal: PlanProposal = {
    batches,
    flexSlots: [
      { day: '2026-04-18', mealTime: 'dinner' as const, flexBonus: 350, note: 'flex dinner' },
    ],
    events: [],
    recipesToGenerate: [],
  };

  return {
    phase: 'awaiting_swap',
    weekStart: horizonStart,
    weekDays: horizonDays,
    breakfast: {
      recipeSlug: 'test-breakfast',
      name: 'Test Breakfast',
      caloriesPerDay: 500,
      proteinPerDay: 30,
    },
    events: [],
    proposal,
    pendingGaps: undefined,
    activeGapIndex: undefined,
    horizonStart,
    horizonDays,
  };
}

test('flex_move overflow rejection rolls back full state (Plan 009)', async () => {
  const state = makeTestState();

  // Deep copy the original state for comparison
  const originalProposal = JSON.parse(JSON.stringify(state.proposal));
  const originalPendingGaps = state.pendingGaps;
  const originalActiveGapIndex = state.activeGapIndex;
  const originalPhase = state.phase;

  // Mock LLM returns: flex_move from Sat dinner (auto-detected) to Sun dinner
  const llm = makeMockLLM('2026-04-19', 'dinner');

  const result = await handleSwapText(state, 'Move flex to Sunday dinner', llm, mockRecipeDb, mockStore);

  // Should return rejection text
  assert.ok(
    result.text.includes("Can't move flex there"),
    `Expected rejection text, got: ${result.text}`,
  );

  // proposal should be unchanged (deep equality)
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(result.state.proposal)),
    originalProposal,
    'Proposal was not fully rolled back',
  );

  // pendingGaps should be unchanged
  assert.deepStrictEqual(
    result.state.pendingGaps,
    originalPendingGaps,
    'pendingGaps was not rolled back',
  );

  // activeGapIndex should be unchanged
  assert.strictEqual(
    result.state.activeGapIndex,
    originalActiveGapIndex,
    'activeGapIndex was not rolled back',
  );

  // phase should be unchanged
  assert.strictEqual(
    result.state.phase,
    originalPhase,
    'phase was not rolled back',
  );
});
