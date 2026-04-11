/**
 * Plan 026 — fixture-LLM tests for the re-proposer's new rules.
 *
 * These tests pin down two behaviors that the re-proposer MUST exhibit after
 * Plan 026 lands:
 *
 *   1. Meal-type lane rule (both modes): the prompt must instruct the LLM
 *      that dinner-only recipes cannot land in lunch batches and vice versa.
 *      We verify by reading the system prompt that `reProposePlan` builds.
 *
 *   2. Near-future safety rule (post-confirmation mode only): the prompt must
 *      include a soft-lock window for the next ~2 days.
 *
 * We do NOT call the real LLM — we capture the messages the provider receives
 * and inspect them. This is a white-box test on prompt construction because
 * the rules are prompt-level requirements.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reProposePlan } from '../../src/agents/plan-reproposer.js';
import type { LLMProvider } from '../../src/ai/provider.js';
import type { RecipeDatabase } from '../../src/recipes/database.js';

function capturingLLM(): { provider: LLMProvider; lastSystemPrompt: () => string } {
  let lastSystem = '';
  const provider: LLMProvider = {
    async complete(opts: { messages: Array<{ role: string; content: string }> }) {
      lastSystem = opts.messages.find((m) => m.role === 'system')?.content ?? '';
      return {
        content: JSON.stringify({
          type: 'proposal',
          batches: [],
          flex_slots: [],
          events: [],
          reasoning: 'stub',
        }),
        usage: { inputTokens: 0, outputTokens: 0 },
      } as any;
    },
  } as unknown as LLMProvider;
  return { provider, lastSystemPrompt: () => lastSystem };
}

const fakeDb: RecipeDatabase = {
  getBySlug: () => undefined,
  getAll: () => [],
} as unknown as RecipeDatabase;

test('meal-type lane rule is present in both in-session and post-confirmation prompts', async () => {
  for (const mode of ['in-session', 'post-confirmation'] as const) {
    const { provider, lastSystemPrompt } = capturingLLM();
    await reProposePlan(
      {
        currentProposal: { batches: [], flexSlots: [], events: [], recipesToGenerate: [] },
        userMessage: 'any',
        mutationHistory: [],
        availableRecipes: [],
        horizonDays: ['2026-04-06'],
        preCommittedSlots: [],
        breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
        weeklyTargets: { calories: 17000, protein: 1050 },
        mode,
        nearFutureDays: mode === 'post-confirmation' ? ['2026-04-07', '2026-04-08'] : undefined,
      },
      provider,
      fakeDb,
    );
    const prompt = lastSystemPrompt();
    assert.match(prompt, /meal[- ]type lane/i, `${mode}: prompt missing meal-type lane rule`);
    assert.match(prompt, /batch\.mealType.*recipe\.mealTypes|recipe's.*mealTypes/i,
      `${mode}: prompt must refer to the invariant in code terms`);
  }
});

test('near-future safety rule is present ONLY in post-confirmation mode', async () => {
  const { provider: inSessionLLM, lastSystemPrompt: inSessionPrompt } = capturingLLM();
  await reProposePlan(
    {
      currentProposal: { batches: [], flexSlots: [], events: [], recipesToGenerate: [] },
      userMessage: 'any',
      mutationHistory: [],
      availableRecipes: [],
      horizonDays: ['2026-04-06'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'in-session',
    },
    inSessionLLM,
    fakeDb,
  );
  assert.doesNotMatch(inSessionPrompt(), /near[- ]future safety/i,
    'in-session prompt must NOT include near-future safety (planning doesn\'t need it)');

  const { provider: postLLM, lastSystemPrompt: postPrompt } = capturingLLM();
  await reProposePlan(
    {
      currentProposal: { batches: [], flexSlots: [], events: [], recipesToGenerate: [] },
      userMessage: 'any',
      mutationHistory: [],
      availableRecipes: [],
      horizonDays: ['2026-04-06'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-07', '2026-04-08'],
    },
    postLLM,
    fakeDb,
  );
  const post = postPrompt();
  assert.match(post, /near[- ]future safety/i);
  assert.match(post, /2026-04-07/, 'near-future days must be inlined into the prompt');
  assert.match(post, /2026-04-08/);
});

/*
 * Behavioral tests — fixture-LLM drives a real reProposePlan call through the
 * validator retry loop. These prove the validator actually catches a
 * lane-crossing LLM response and either retries into a clean proposal or
 * returns failure — i.e., the rules are load-bearing end-to-end, not just
 * lint-level copy in the system prompt.
 */

/**
 * Queue-based fixture LLM: returns one scripted response per complete() call.
 * Used to simulate the LLM producing a rule-violating proposal first and then
 * correcting on the retry, so we can assert the validator caught the first
 * round and prompt-feedback worked.
 */
function queuedFixtureLLM(responses: string[]): LLMProvider {
  const queue = [...responses];
  return {
    async complete() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('queuedFixtureLLM: no more scripted responses');
      }
      return { content: next, usage: { inputTokens: 0, outputTokens: 0 } } as any;
    },
  } as unknown as LLMProvider;
}

/** Minimal recipe DB with a dinner-only and a lunch+dinner recipe so invariant #14 has something to compare against. */
const behavioralRecipeDb: RecipeDatabase = {
  getBySlug(slug: string) {
    if (slug === 'tagine') {
      return {
        slug: 'tagine', name: 'tagine', shortName: 'tagine',
        mealTypes: ['dinner'] as const, // dinner-only
        cuisine: 'moroccan', tags: [], prepTimeMinutes: 45,
        structure: [{ type: 'main' as const, name: 'Main' }],
        perServing: { calories: 700, protein: 40, fat: 25, carbs: 60 },
        ingredients: [{ name: 'lamb', amount: 150, unit: 'g', role: 'protein' as const, component: 'Main' }],
        storage: { fridgeDays: 4, freezable: true, reheat: 'microwave 3m' },
        body: '',
      } as any;
    }
    if (slug === 'grain-bowl') {
      return {
        slug: 'grain-bowl', name: 'grain bowl', shortName: 'grain-bowl',
        mealTypes: ['lunch', 'dinner'] as const,
        cuisine: 'modern', tags: [], prepTimeMinutes: 20,
        structure: [{ type: 'main' as const, name: 'Main' }],
        perServing: { calories: 600, protein: 35, fat: 20, carbs: 70 },
        ingredients: [{ name: 'quinoa', amount: 100, unit: 'g', role: 'carb' as const, component: 'Main' }],
        storage: { fridgeDays: 3, freezable: false, reheat: 'room temp' },
        body: '',
      } as any;
    }
    return undefined;
  },
  getAll() { return []; },
} as unknown as RecipeDatabase;

test('meal-type lane violation: validator catches dinner-only recipe in lunch batch and forces retry', async () => {
  // Minimal 1-day horizon: one lunch slot (batch) + one dinner slot (flex).
  // The flex satisfies invariant #8 (count = 1) and invariant #1 (covers dinner).
  // The batch covers lunch. With this layout, the only invariant the LLM can
  // violate is #14 — exactly what we want to exercise.
  const badProposal = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'tagine', recipe_name: 'tagine', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [{ day: '2026-04-08', meal_time: 'dinner', flex_bonus: 350, note: 'flex dinner' }],
    events: [],
    reasoning: 'naive first-try (should fail invariant #14)',
  };
  const goodProposal = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'grain-bowl', recipe_name: 'grain bowl', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [{ day: '2026-04-08', meal_time: 'dinner', flex_bonus: 350, note: 'flex dinner' }],
    events: [],
    reasoning: 'corrected after retry — lane-safe',
  };
  const llm = queuedFixtureLLM([JSON.stringify(badProposal), JSON.stringify(goodProposal)]);

  const result = await reProposePlan(
    {
      currentProposal: {
        batches: [{ recipeSlug: 'grain-bowl', recipeName: 'grain bowl', mealType: 'lunch', days: ['2026-04-08'], servings: 1, overflowDays: undefined }],
        flexSlots: [{ day: '2026-04-08', mealTime: 'dinner', flexBonus: 350, note: 'flex dinner' }],
        events: [],
        recipesToGenerate: [],
      },
      userMessage: 'put tagine in lunch instead',
      mutationHistory: [],
      availableRecipes: [
        { slug: 'tagine', name: 'tagine', mealTypes: ['dinner'], cuisine: 'moroccan', tags: ['one-pot'], calories: 700, protein: 40, proteinSource: 'lamb', fridgeDays: 4 },
        { slug: 'grain-bowl', name: 'grain bowl', mealTypes: ['lunch', 'dinner'], cuisine: 'modern', tags: ['bowl', 'portable'], calories: 600, protein: 35, proteinSource: 'chicken', fridgeDays: 3 },
      ],
      horizonDays: ['2026-04-08'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-08', '2026-04-09'],
    },
    llm,
    behavioralRecipeDb,
  );

  // The retry succeeds — result is a valid proposal using the lane-safe recipe.
  assert.equal(result.type, 'proposal');
  if (result.type !== 'proposal') throw new Error('unreachable');
  assert.equal(result.proposal.batches.length, 1);
  assert.equal(result.proposal.batches[0]!.recipeSlug, 'grain-bowl');
  assert.equal(result.proposal.batches[0]!.mealType, 'lunch');
});

test('meal-type lane violation: two retries both fail → reProposePlan returns failure', async () => {
  // Both the first and second LLM responses put a dinner-only recipe in a lunch
  // batch. After two validator-driven retries, reProposePlan must surface a
  // failure rather than silently returning the bad proposal.
  const bad = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'tagine', recipe_name: 'tagine', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [{ day: '2026-04-08', meal_time: 'dinner', flex_bonus: 350, note: 'flex dinner' }],
    events: [],
    reasoning: 'still wrong',
  };
  const llm = queuedFixtureLLM([JSON.stringify(bad), JSON.stringify(bad)]);

  const result = await reProposePlan(
    {
      currentProposal: {
        batches: [{ recipeSlug: 'grain-bowl', recipeName: 'grain bowl', mealType: 'lunch', days: ['2026-04-08'], servings: 1, overflowDays: undefined }],
        flexSlots: [{ day: '2026-04-08', mealTime: 'dinner', flexBonus: 350, note: 'flex dinner' }],
        events: [],
        recipesToGenerate: [],
      },
      userMessage: 'put tagine in lunch instead',
      mutationHistory: [],
      availableRecipes: [
        { slug: 'tagine', name: 'tagine', mealTypes: ['dinner'], cuisine: 'moroccan', tags: ['one-pot'], calories: 700, protein: 40, proteinSource: 'lamb', fridgeDays: 4 },
      ],
      horizonDays: ['2026-04-08'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-08', '2026-04-09'],
    },
    llm,
    behavioralRecipeDb,
  );

  assert.equal(result.type, 'failure', 'two lane violations in a row must surface as failure');
});

test('near-future safety: prompt carries soft-locked dates and a respectful response round-trips cleanly', async () => {
  // The near-future safety rule is prompt-only (no validator invariant backs it
  // up — rearranging a near-future slot is a soft violation of user intent, not a
  // structural plan invariant). This test asserts the prompt flows the soft-locked
  // dates to the LLM end-to-end and that a response that respects the rule passes
  // through as a clean proposal.
  //
  // Use a 1-day horizon so the response only needs one batch + one flex to
  // satisfy every other invariant — the only thing under test is whether the
  // LLM respects the near-future window in the system prompt.
  const respectful = {
    type: 'proposal',
    batches: [
      { recipe_slug: 'grain-bowl', recipe_name: 'grain bowl', meal_type: 'lunch', days: ['2026-04-08'], servings: 1 },
    ],
    flex_slots: [{ day: '2026-04-08', meal_time: 'dinner', flex_bonus: 350, note: 'flex dinner' }],
    events: [],
    reasoning: 'kept everything in the soft-locked window unchanged',
  };
  const { provider, lastSystemPrompt } = capturingLLM();
  // Override complete once: keep the prompt-capture side-effect, return scripted response.
  const originalComplete = provider.complete.bind(provider);
  (provider as any).complete = async (opts: any) => {
    await originalComplete(opts); // populate lastSystemPrompt side-effect
    return { content: JSON.stringify(respectful), usage: { inputTokens: 0, outputTokens: 0 } };
  };

  const result = await reProposePlan(
    {
      currentProposal: {
        batches: [{ recipeSlug: 'grain-bowl', recipeName: 'grain bowl', mealType: 'lunch', days: ['2026-04-08'], servings: 1, overflowDays: undefined }],
        flexSlots: [{ day: '2026-04-08', mealTime: 'dinner', flexBonus: 350, note: 'flex dinner' }],
        events: [],
        recipesToGenerate: [],
      },
      userMessage: 'leave the soft-locked days alone',
      mutationHistory: [],
      availableRecipes: [
        { slug: 'grain-bowl', name: 'grain bowl', mealTypes: ['lunch', 'dinner'], cuisine: 'modern', tags: ['bowl', 'portable'], calories: 600, protein: 35, proteinSource: 'chicken', fridgeDays: 3 },
      ],
      horizonDays: ['2026-04-08'],
      preCommittedSlots: [],
      breakfast: { name: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      weeklyTargets: { calories: 17000, protein: 1050 },
      mode: 'post-confirmation',
      nearFutureDays: ['2026-04-08', '2026-04-09'],
    },
    provider,
    behavioralRecipeDb,
  );

  // Prompt carried the soft-locked dates.
  assert.match(lastSystemPrompt(), /2026-04-08/);
  assert.match(lastSystemPrompt(), /2026-04-09/);
  // A rule-respecting LLM response comes through as a clean proposal.
  assert.equal(result.type, 'proposal');
  if (result.type !== 'proposal') throw new Error('unreachable');
  assert.deepStrictEqual(result.proposal.batches[0]!.days, ['2026-04-08']);
});
