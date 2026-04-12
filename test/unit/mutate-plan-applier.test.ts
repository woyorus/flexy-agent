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

// ─── Regression: past-day slots must not block mid-week mutations ────────────
//
// Reproduces the bug seen in data/logs/debug.log at 2026-04-12 14:14. A
// confirmed session spans Fri 2026-04-10 → Thu 2026-04-16. "Now" is Sun
// 2026-04-12 14:00, so Fri + Sat are past (both meals). The re-proposer
// only sees forward batches — `sessionToPostConfirmationProposal` correctly
// strips past batches into `preservedPastBatches`. But the applier hard-codes
// `preCommittedSlots: []` when calling the re-proposer while still passing
// the FULL session horizon (04-10…04-16). The validator then walks every
// horizon day × mealType and rejects the past-day slots as uncovered, forcing
// two retries and a terminal failure.
//
// The LLM stub returns a clean, forward-only proposal (the one the real model
// produced in the bug log: keep forward batches, move the flex to Sun lunch,
// add a skip-dinner event). A correctly wired applier would pass the past
// batches through as pre-committed slots (or trim the horizon to forward-only)
// so this clean proposal validates on the first pass. Under the bug, it
// doesn't: validator errors #1 fire four times, the re-proposer retries with
// the same stub (or fails to produce anything valid), and the applier returns
// `kind: 'failure'`.
test('applyMutationRequest: past-session batches do not trigger slot-coverage failures', async () => {
  const sessionId = 'sess-past-batches';
  const activeSession = {
    id: sessionId,
    horizonStart: '2026-04-10',
    horizonEnd: '2026-04-16',
    breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
    treatBudgetCalories: 800,
    flexSlots: [{ day: '2026-04-12', mealTime: 'dinner' as const, flexBonus: 350, note: 'flex' }],
    events: [],
    mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-09T18:00:00.000Z' }],
    confirmedAt: '2026-04-09T18:00:00.000Z',
    superseded: false,
    createdAt: '2026-04-09T18:00:00.000Z',
    updatedAt: '2026-04-09T18:00:00.000Z',
  };

  const baseBatch = {
    targetPerServing: { calories: 800, protein: 50 },
    actualPerServing: { calories: 800, protein: 50, fat: 25, carbs: 80 },
    scaledIngredients: [] as any[],
    status: 'planned' as const,
    createdInPlanSessionId: sessionId,
  };
  const batches = [
    // PAST (Fri+Sat): consumed lunch + dinner batches. These belong in
    // preservedPastBatches after the adapter runs.
    { ...baseBatch, id: 'b-past-lunch', recipeSlug: 'tuna-bowl',
      mealType: 'lunch' as const, eatingDays: ['2026-04-10', '2026-04-11'], servings: 2 },
    { ...baseBatch, id: 'b-past-dinner', recipeSlug: 'beef-ragu',
      mealType: 'dinner' as const, eatingDays: ['2026-04-10', '2026-04-11'], servings: 2 },
    // FORWARD (Sun–Thu): what the re-proposer actually sees + can modify.
    { ...baseBatch, id: 'b-fwd-lunch-1', recipeSlug: 'chicken-bowl',
      mealType: 'lunch' as const, eatingDays: ['2026-04-12', '2026-04-13', '2026-04-14'], servings: 3 },
    { ...baseBatch, id: 'b-fwd-dinner-1', recipeSlug: 'salmon-pasta',
      mealType: 'dinner' as const, eatingDays: ['2026-04-13', '2026-04-14'], servings: 2 },
    { ...baseBatch, id: 'b-fwd-lunch-2', recipeSlug: 'pork-bowl',
      mealType: 'lunch' as const, eatingDays: ['2026-04-15', '2026-04-16'], servings: 2 },
    { ...baseBatch, id: 'b-fwd-dinner-2', recipeSlug: 'beef-tagine',
      mealType: 'dinner' as const, eatingDays: ['2026-04-15', '2026-04-16'], servings: 2 },
  ];

  // Minimal recipe DB — every slug referenced in batches or the proposal must
  // exist with plausible fridge-life + mealTypes so invariants #7, #10, #14
  // don't fire on structural grounds.
  const makeRecipe = (slug: string, mealType: 'lunch' | 'dinner') => ({
    slug, name: slug, shortName: slug,
    mealTypes: [mealType],
    cuisine: 'test', tags: [], prepTimeMinutes: 30,
    structure: [{ type: 'main', name: 'Main' }],
    perServing: { calories: 800, protein: 50, fat: 25, carbs: 80 },
    ingredients: [],
    storage: { fridgeDays: 3, freezable: true, reheat: 'microwave' },
    body: '',
  }) as any;
  const lunchSlugs = new Set(['tuna-bowl', 'chicken-bowl', 'pork-bowl']);
  const dinnerSlugs = new Set(['beef-ragu', 'salmon-pasta', 'beef-tagine']);
  const recipeDb: RecipeDatabase = {
    getAll: () => [],
    getBySlug: (slug: string) => {
      if (lunchSlugs.has(slug)) return makeRecipe(slug, 'lunch');
      if (dinnerSlugs.has(slug)) return makeRecipe(slug, 'dinner');
      return undefined;
    },
  } as unknown as RecipeDatabase;

  const store: StateStoreLike = {
    async getRunningPlanSession() { return activeSession; },
    async getFuturePlanSessions() { return []; },
    async getBatchesByPlanSessionId() { return batches; },
  } as unknown as StateStoreLike;

  // Forward-only proposal mirroring the real LLM's first attempt in the bug
  // log (debug.log:1661-1720): keep every forward batch unchanged and leave
  // the flex on Sun 2026-04-12 dinner. This is the simplest proposal that
  // covers every ACTIVE slot exactly once (invariants #1, #2, #8). If the
  // applier is correctly trimming the horizon to forward-only and passing
  // past batches as pre-committed, this proposal validates on the first
  // pass. Under the bug, the validator rejects Fri+Sat (both meals) as
  // uncovered.
  const cleanForwardProposal = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'chicken-bowl', recipe_name: 'chicken bowl', meal_type: 'lunch',
        eating_days: ['2026-04-12', '2026-04-13', '2026-04-14'], overflow_days: [], servings: 3 },
      { recipe_slug: 'salmon-pasta', recipe_name: 'salmon pasta', meal_type: 'dinner',
        eating_days: ['2026-04-13', '2026-04-14'], overflow_days: [], servings: 2 },
      { recipe_slug: 'pork-bowl', recipe_name: 'pork bowl', meal_type: 'lunch',
        eating_days: ['2026-04-15', '2026-04-16'], overflow_days: [], servings: 2 },
      { recipe_slug: 'beef-tagine', recipe_name: 'beef tagine', meal_type: 'dinner',
        eating_days: ['2026-04-15', '2026-04-16'], overflow_days: [], servings: 2 },
    ],
    flex_slots: [
      { day: '2026-04-12', meal_time: 'dinner', flex_bonus: 350, note: 'flex' },
    ],
    events: [],
    reasoning: 'no structural changes — forward plan already covers every active slot',
  };
  // Queue twice — if the bug is live, the first validation fails (past days
  // uncovered) and the re-proposer retries; the second identical response also
  // fails validation, which surfaces as `kind: 'failure'`. Under the fix, the
  // first response validates cleanly and the second is never consumed.
  const llm = queuedLLM([
    JSON.stringify(cleanForwardProposal),
    JSON.stringify(cleanForwardProposal),
  ]);

  const result = await applyMutationRequest({
    request: 'use the flex as late lunch, no dinner today',
    session: { planFlow: null },
    store,
    recipes: recipeDb,
    llm,
    now: new Date('2026-04-12T14:00:00'),
  });

  // The load-bearing assertion. A forward-only proposal that covers every
  // forward slot MUST NOT be rejected because the validator was handed the
  // full 7-day horizon with no pre-committed context for past days. Pre-fix
  // this fails with `kind: 'failure'`; post-fix it returns
  // `kind: 'post_confirmation_proposed'`.
  if (result.kind === 'failure') {
    throw new Error(
      `Expected the forward-only proposal to validate, got failure: "${result.message}". ` +
      `This reproduces the 2026-04-12 bug where the applier hard-codes preCommittedSlots: [] ` +
      `while handing the re-proposer the full session horizon, so past-day slots fail the ` +
      `coverage invariant even though they were already covered by consumed batches.`,
    );
  }
  assert.equal(result.kind, 'post_confirmation_proposed');
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
