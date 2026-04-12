/**
 * Unit tests for the mutate-plan applier — Plan 029.
 *
 * Task 7: in-session branch delegates to handleMutationText and returns
 * an in_session_updated result. We exercise the branch with a stub LLM
 * that returns a clarification response (shortest path through the
 * re-proposer), verifying the applier emits the expected result shape
 * AND preserves planFlow.pendingClarification.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyMutationRequest } from '../../src/plan/mutate-plan-applier.js';
import type { PlanFlowState } from '../../src/agents/plan-flow.js';
import type { LLMProvider } from '../../src/ai/provider.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';
import type { StateStoreLike } from '../../src/state/store.js';

function seededFlowState(): PlanFlowState {
  return {
    phase: 'proposal',
    weekStart: '2026-04-06',
    weekDays: [
      '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
      '2026-04-10', '2026-04-11', '2026-04-12',
    ],
    horizonStart: '2026-04-06',
    horizonDays: [
      '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
      '2026-04-10', '2026-04-11', '2026-04-12',
    ],
    breakfast: {
      recipeSlug: 'oatmeal',
      name: 'Oatmeal',
      caloriesPerDay: 450,
      proteinPerDay: 25,
    },
    events: [],
    proposal: {
      batches: [],
      flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }],
      events: [],
      recipesToGenerate: [],
    },
    mutationHistory: [],
    preCommittedSlots: [],
  };
}

function queuedLLM(responses: string[]): LLMProvider {
  const q = [...responses];
  return {
    async complete() {
      const next = q.shift();
      if (next === undefined) throw new Error('queuedLLM: unexpected extra call');
      return { content: next, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async transcribe() {
      throw new Error('queuedLLM: transcribe not supported');
    },
  };
}

const fakeRecipeDb: RecipeDatabase = {
  getAll: () => [],
  getBySlug: () => undefined,
} as unknown as RecipeDatabase;

const fakeStore: StateStoreLike = {
  getRunningPlanSession: async () => null,
  getFuturePlanSessions: async () => [],
  getRecentPlanSessions: async () => [],
} as unknown as StateStoreLike;

test('applyMutationRequest: in-session branch with clarification response bubbles up', async () => {
  const state = seededFlowState();
  const session = { planFlow: state };

  const llm = queuedLLM([
    JSON.stringify({
      type: 'clarification',
      question: 'Which meal — lunch or dinner?',
    }),
  ]);

  const result = await applyMutationRequest({
    request: 'I went to the Indian place',
    session,
    store: fakeStore,
    recipes: fakeRecipeDb,
    llm,
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') throw new Error('unreachable');
  assert.match(result.question, /lunch or dinner/);

  // handleMutationText set planFlow.pendingClarification on the state.
  assert.ok(state.pendingClarification);
  assert.equal(state.pendingClarification!.originalMessage, 'I went to the Indian place');
});

test('applyMutationRequest: in-session branch with failure returns MutateResult failure', async () => {
  const state = seededFlowState();
  // Two validation failures trigger the re-proposer's failure path.
  const llm = queuedLLM([
    JSON.stringify({ type: 'proposal', batches: [], flex_slots: [], events: [], reasoning: '' }),
    JSON.stringify({ type: 'proposal', batches: [], flex_slots: [], events: [], reasoning: '' }),
  ]);

  const result = await applyMutationRequest({
    request: 'do something impossible',
    session: { planFlow: state },
    store: fakeStore,
    recipes: fakeRecipeDb,
    llm,
  });

  // The re-proposer's validator rejects the empty proposals twice,
  // returning type='failure'. The applier maps that to MutateResult.failure.
  assert.equal(result.kind, 'failure');
});

// ─── Post-confirmation branch tests ──────────────────────────────────────────

test('applyMutationRequest: post-confirmation no-target when no active plan', async () => {
  const emptyStore: StateStoreLike = {
    async getRunningPlanSession() { return null; },
    async getFuturePlanSessions() { return []; },
    async getLatestHistoricalPlanSession() { return null; },
    async getRecentPlanSessions() { return []; },
    async getBatchesByPlanSessionId() { return []; },
  } as unknown as StateStoreLike;

  const result = await applyMutationRequest({
    request: 'move tomorrow dinner',
    session: { planFlow: null },
    store: emptyStore,
    recipes: fakeRecipeDb,
    llm: queuedLLM([]),
    now: new Date('2026-04-07T19:00:00'),
  });

  assert.equal(result.kind, 'no_target');
});

test('applyMutationRequest: post-confirmation clarification bubbles up', async () => {
  const session = {
    id: 'sess-1',
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
    treatBudgetCalories: 800,
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner' as const, flexBonus: 350 }],
    events: [],
    mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
    confirmedAt: '2026-04-05T18:00:00.000Z',
    superseded: false,
    createdAt: '2026-04-05T18:00:00.000Z',
    updatedAt: '2026-04-05T18:00:00.000Z',
  };
  const batches = [
    {
      id: 'b-1',
      recipeSlug: 'tagine',
      mealType: 'dinner' as const,
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
      targetPerServing: { calories: 800, protein: 45 },
      actualPerServing: { calories: 810, protein: 46, fat: 30, carbs: 60 },
      scaledIngredients: [{ name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' as const }],
      status: 'planned' as const,
      createdInPlanSessionId: 'sess-1',
    },
  ];
  const store: StateStoreLike = {
    async getRunningPlanSession() { return session; },
    async getFuturePlanSessions() { return []; },
    async getBatchesByPlanSessionId() { return batches; },
  } as unknown as StateStoreLike;

  const llm = queuedLLM([
    JSON.stringify({
      type: 'clarification',
      question: 'Did you mean tonight or tomorrow night?',
    }),
  ]);

  const result = await applyMutationRequest({
    request: 'eating out',
    session: { planFlow: null },
    store,
    recipes: fakeRecipeDb,
    llm,
    now: new Date('2026-04-07T19:00:00'),
  });

  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') throw new Error('unreachable');
  assert.match(result.question, /tonight or tomorrow night/);
});
