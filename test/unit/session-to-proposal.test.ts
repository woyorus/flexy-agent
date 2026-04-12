/**
 * Unit tests for the session-to-proposal adapter (Plan 026).
 *
 * These tests cover the four pure functions exposed by
 * `src/plan/session-to-proposal.ts` in isolation, then the end-to-end
 * round-trip from persisted session to re-proposer-ready proposal and back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Batch, MealEvent, MutationRecord, PlanSession } from '../../src/models/types.js';
import type { PlanProposal } from '../../src/solver/types.js';
import {
  buildReplacingDraft,
  classifySlot,
  sessionToPostConfirmationProposal,
  splitBatchAtCutoffs,
} from '../../src/plan/session-to-proposal.js';

// Fixed clock helpers — tests construct Date objects directly with local time.
// The adapter reads only wall-clock from `now`, never Date.now() or new Date().
function at(isoDate: string, hour: number, minute = 0): Date {
  // Construct in the runtime's local timezone so the adapter's
  // toLocalISODate(now) maps back to `isoDate`. Mirrors how scenarios freeze
  // clocks (see src/harness/clock.ts).
  return new Date(`${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
}

test('classifySlot: date before today is always past for both meal types', () => {
  const now = at('2026-04-07', 10); // Tuesday morning
  assert.equal(classifySlot('2026-04-06', 'lunch', now), 'past');
  assert.equal(classifySlot('2026-04-06', 'dinner', now), 'past');
});

test('classifySlot: date after today is always active for both meal types', () => {
  const now = at('2026-04-07', 23);
  assert.equal(classifySlot('2026-04-08', 'lunch', now), 'active');
  assert.equal(classifySlot('2026-04-08', 'dinner', now), 'active');
});

test('classifySlot: today lunch is active before 15:00', () => {
  assert.equal(classifySlot('2026-04-07', 'lunch', at('2026-04-07', 14, 59)), 'active');
});

test('classifySlot: today lunch is past at 15:00', () => {
  assert.equal(classifySlot('2026-04-07', 'lunch', at('2026-04-07', 15, 0)), 'past');
});

test('classifySlot: today dinner is active at 15:00 (lunch cutoff does not affect dinner)', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 15, 0)), 'active');
});

test('classifySlot: today dinner is active at 20:59', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 20, 59)), 'active');
});

test('classifySlot: today dinner is past at 21:00', () => {
  assert.equal(classifySlot('2026-04-07', 'dinner', at('2026-04-07', 21, 0)), 'past');
});

function batch(overrides: Partial<Batch>): Batch {
  return {
    id: 'batch-x',
    recipeSlug: 'tagine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
    targetPerServing: { calories: 800, protein: 45 },
    actualPerServing: { calories: 810, protein: 46, fat: 30, carbs: 60 },
    scaledIngredients: [
      { name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
    ],
    status: 'planned',
    createdInPlanSessionId: 'sess-1',
    ...overrides,
  };
}

test('splitBatchAtCutoffs: pure past batch — all eating days strictly before today', () => {
  // Now = Thursday 10am. All eating days Mon/Tue/Wed are past.
  const now = at('2026-04-09', 10);
  const b = batch({
    id: 'past-batch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
  if (result.kind !== 'past-only') throw new Error('unreachable');
  assert.deepStrictEqual(result.pastBatch, b);
});

test('splitBatchAtCutoffs: pure active batch — all eating days after today', () => {
  // Now = Monday 10am. Eating days Tue/Wed/Thu all active.
  const now = at('2026-04-06', 10);
  const b = batch({
    id: 'future-batch',
    eatingDays: ['2026-04-07', '2026-04-08', '2026-04-09'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'active-only');
  if (result.kind !== 'active-only') throw new Error('unreachable');
  assert.deepStrictEqual(result.activeBatch, {
    recipeSlug: 'tagine',
    recipeName: 'tagine',
    mealType: 'dinner',
    days: ['2026-04-07', '2026-04-08', '2026-04-09'],
    servings: 3,
    overflowDays: undefined,
  });
});

test('splitBatchAtCutoffs: pure active — today lunch batch before 15:00 stays fully active', () => {
  const now = at('2026-04-07', 10);
  const b = batch({
    id: 'today-lunch',
    mealType: 'lunch',
    eatingDays: ['2026-04-07'],
    servings: 1,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'active-only');
});

test('splitBatchAtCutoffs: pure past — today lunch batch after 15:00 is past', () => {
  const now = at('2026-04-07', 15, 30);
  const b = batch({
    id: 'today-lunch-late',
    mealType: 'lunch',
    eatingDays: ['2026-04-07'],
    servings: 1,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
});

test('splitBatchAtCutoffs: spanning batch — split at the cutoff boundary', () => {
  // Now = Friday 10am. Tagine batch with eating days Mon, Wed, Fri — all dinner.
  // Mon and Wed are past (dates before today). Fri is active (today, 10am < 21:00 cutoff).
  const now = at('2026-04-10', 10);
  const b = batch({
    id: 'tagine-spanning',
    recipeSlug: 'tagine',
    mealType: 'dinner',
    eatingDays: ['2026-04-06', '2026-04-08', '2026-04-10'],
    servings: 3,
    scaledIngredients: [
      { name: 'beef', amount: 200, unit: 'g', totalForBatch: 600, role: 'protein' },
      { name: 'couscous', amount: 60, unit: 'g', totalForBatch: 180, role: 'carb' },
    ],
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'spanning');
  if (result.kind !== 'spanning') throw new Error('unreachable');

  // Past half: Mon + Wed, 2 servings, totals proportionally scaled down.
  assert.equal(result.pastBatch.recipeSlug, 'tagine');
  assert.equal(result.pastBatch.mealType, 'dinner');
  assert.deepStrictEqual(result.pastBatch.eatingDays, ['2026-04-06', '2026-04-08']);
  assert.equal(result.pastBatch.servings, 2);
  assert.equal(result.pastBatch.status, 'planned');
  assert.equal(result.pastBatch.createdInPlanSessionId, 'sess-1');
  assert.deepStrictEqual(result.pastBatch.scaledIngredients, [
    { name: 'beef', amount: 200, unit: 'g', totalForBatch: 400, role: 'protein' },
    { name: 'couscous', amount: 60, unit: 'g', totalForBatch: 120, role: 'carb' },
  ]);
  // Past half must get a NEW id — it becomes a new row in the next session.
  assert.notEqual(result.pastBatch.id, 'tagine-spanning');

  // Active half: Fri, 1 serving, as a ProposedBatch.
  assert.deepStrictEqual(result.activeBatch, {
    recipeSlug: 'tagine',
    recipeName: 'tagine',
    mealType: 'dinner',
    days: ['2026-04-10'],
    servings: 1,
    overflowDays: undefined,
  });
});

function session(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    id: 'sess-1',
    horizonStart: '2026-04-06',
    horizonEnd: '2026-04-12',
    breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
    treatBudgetCalories: 800,
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350, note: 'fun dinner' }],
    events: [],
    mutationHistory: [],
    confirmedAt: '2026-04-05T18:00:00.000Z',
    superseded: false,
    createdAt: '2026-04-05T18:00:00.000Z',
    updatedAt: '2026-04-05T18:00:00.000Z',
    ...overrides,
  };
}

test('sessionToPostConfirmationProposal: Tuesday 7pm with Monday dinner fully past', () => {
  const now = at('2026-04-07', 19);
  const sess = session();
  const batches: Batch[] = [
    batch({
      id: 'b-tagine',
      recipeSlug: 'tagine',
      mealType: 'dinner',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
    }),
    batch({
      id: 'b-grainbowl',
      recipeSlug: 'grain-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
      servings: 3,
    }),
  ];

  const result = sessionToPostConfirmationProposal(sess, batches, now);

  // Horizon days — unchanged, same 7 days as the session.
  assert.deepStrictEqual(result.horizonDays, [
    '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
    '2026-04-10', '2026-04-11', '2026-04-12',
  ]);

  // Preserved past batches: at 19:00 Tuesday, tagine spans (Mon past, Tue/Wed
  // active dinner since 19:00 < 21:00), grain-bowl spans (Mon/Tue lunch past
  // since 19:00 > 15:00, Wed lunch active).
  const pastSlugs = result.preservedPastBatches.map((b) => `${b.recipeSlug}:${b.eatingDays.join(',')}`);
  assert.deepStrictEqual(pastSlugs.sort(), [
    'grain-bowl:2026-04-06,2026-04-07',
    'tagine:2026-04-06',
  ]);

  // Active proposal batches
  const activeSlugs = result.activeProposal.batches.map((b) => `${b.recipeSlug}:${b.days.join(',')}/${b.servings}`);
  assert.deepStrictEqual(activeSlugs.sort(), [
    'grain-bowl:2026-04-08/1',
    'tagine:2026-04-07,2026-04-08/2',
  ]);

  // Active proposal carries flex slots and events that fall on active slots only.
  // The seed session's sole flex slot is on Saturday (active), so it lands in activeProposal.
  assert.deepStrictEqual(result.activeProposal.flexSlots, sess.flexSlots);
  assert.deepStrictEqual(result.activeProposal.events, []);
  assert.deepStrictEqual(result.activeProposal.recipesToGenerate, []);

  // No past flex slots or events in this seed (events is empty, the one flex slot is active).
  assert.deepStrictEqual(result.preservedPastFlexSlots, []);
  assert.deepStrictEqual(result.preservedPastEvents, []);

  // Near-future days: today + tomorrow = 2026-04-07, 2026-04-08.
  assert.deepStrictEqual(result.nearFutureDays, ['2026-04-07', '2026-04-08']);
});

// Small fake LLM + fake recipe DB for the buildReplacingDraft tests below.
// We only need the scaler's fallback branch to kick in (which does not call
// the LLM). The real scaler in plan-flow.ts wraps LLM failures with a
// pass-through of recipe.ingredients (see src/agents/plan-flow.ts:904-914).
// We reproduce that behavior by throwing from the LLM so buildReplacingDraft
// uses its own fallback.
const throwingLLM = {
  complete: async () => { throw new Error('test: LLM disabled'); },
} as unknown as import('../../src/ai/provider.js').LLMProvider;

// Fake recipe DB — returns the minimum recipe shape the scaler uses.
const fakeRecipeDb = {
  getBySlug(slug: string) {
    return {
      name: slug, shortName: slug, slug,
      mealTypes: ['dinner'] as const,
      cuisine: 'test', tags: [], prepTimeMinutes: 20,
      structure: [{ type: 'main' as const, name: 'Main' }],
      perServing: { calories: 800, protein: 45, fat: 30, carbs: 60 },
      ingredients: [
        { name: 'protein', amount: 150, unit: 'g', role: 'protein' as const, component: 'Main' },
      ],
      storage: { fridgeDays: 4, freezable: true, reheat: 'microwave 2m' },
      body: '',
    };
  },
  getAll() { return []; },
} as unknown as import('../../src/recipes/database.js').RecipeDatabase;

test('sessionToPostConfirmationProposal: past flex slots and events split into preservedPast* arrays', () => {
  const now = at('2026-04-09', 10); // Thursday morning
  const sess = session({
    flexSlots: [
      { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350 }, // past (Monday)
      { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }, // active (Saturday)
    ],
    // MealEvent shape: { name, day, mealTime, estimatedCalories, notes? }
    // — real type from src/models/types.ts:139.
    events: [
      { name: 'indian restaurant', day: '2026-04-07', mealTime: 'dinner', estimatedCalories: 1200, notes: 'saag paneer' }, // past (Tuesday)
      { name: 'work lunch out', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 800 }, // active (Friday)
    ],
  });
  const result = sessionToPostConfirmationProposal(sess, [], now);

  // Active proposal carries ONLY future/today-active flex slots and events.
  assert.deepStrictEqual(result.activeProposal.flexSlots, [
    { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(result.activeProposal.events, [
    { name: 'work lunch out', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 800 },
  ]);

  // Preserved past arrays carry the dropped ones so the round-trip can splice
  // them back into the rewritten session without erasing the user's record.
  assert.deepStrictEqual(result.preservedPastFlexSlots, [
    { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(result.preservedPastEvents, [
    { name: 'indian restaurant', day: '2026-04-07', mealTime: 'dinner', estimatedCalories: 1200, notes: 'saag paneer' },
  ]);
});

test('splitBatchAtCutoffs: spanning with today lunch past by cutoff', () => {
  // Now = Wednesday 16:00. Lunch batch Mon / Tue / Wed. All three are past
  // (Mon/Tue by date, Wed by cutoff at 16:00 > 15:00). Not actually spanning,
  // but a regression guard that the lunch cutoff applies to today only.
  const now = at('2026-04-08', 16);
  const b = batch({
    id: 'lunch-3day',
    mealType: 'lunch',
    eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
    servings: 3,
  });
  const result = splitBatchAtCutoffs(b, now);
  assert.equal(result.kind, 'past-only');
});

test('buildReplacingDraft: carries mutationHistory, preserves past batches + flex slots + events, writes new batches using solver-backed targets', async () => {
  const oldSess = session({
    id: 'old',
    mutationHistory: [
      { constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' },
    ],
  });
  const preservedPastBatches: Batch[] = [
    batch({
      id: 'past-grainbowl',
      recipeSlug: 'grain-bowl',
      mealType: 'lunch',
      eatingDays: ['2026-04-06', '2026-04-07'],
      servings: 2,
    }),
  ];
  // Past flex slot (Sunday dinner) and past event (Monday lunch out) — both
  // must survive the rewrite or the user's historical record is erased.
  const preservedPastFlexSlots = [
    { day: '2026-04-05', mealTime: 'dinner', flexBonus: 350 } as const,
  ];
  const preservedPastEvents: MealEvent[] = [
    { name: 'office lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'team lunch' },
  ];
  // The caller (Plan D applier) runs the solver on the re-proposer output
  // before invoking buildReplacingDraft. Attach a minimal solver output with
  // one BatchTarget matching the single re-proposed batch so the test can
  // assert that buildReplacingDraft consumes the solver's targetPerServing
  // (not recipe.perServing) as the Batch's targetPerServing.
  const reProposed: PlanProposal = {
    batches: [
      {
        recipeSlug: 'tagine',
        recipeName: 'tagine',
        mealType: 'dinner',
        days: ['2026-04-08', '2026-04-09'],
        servings: 2,
        overflowDays: undefined,
      },
    ],
    flexSlots: [{ day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 }],
    events: [],
    recipesToGenerate: [],
    solverOutput: {
      isValid: true,
      weeklyTotals: { calories: 15000, protein: 900, treatBudget: 800, flexSlotCalories: 350 },
      dailyBreakdown: [],
      batchTargets: [
        {
          id: 'bt-tagine',
          recipeSlug: 'tagine',
          mealType: 'dinner',
          days: ['2026-04-08', '2026-04-09'],
          servings: 2,
          // Solver target deliberately DIFFERS from recipe.perServing (the fake
          // DB returns calories: 800, protein: 45). If buildReplacingDraft wrote
          // recipe.perServing instead of the solver target, the assertion below
          // would fail.
          targetPerServing: { calories: 720, protein: 50 },
        },
      ],
      cookingSchedule: [],
      warnings: [],
    },
  };
  const newMutation: MutationRecord = {
    constraint: 'eating out tonight',
    appliedAt: '2026-04-07T19:30:00.000Z',
  };

  const { draft, batches: newBatches } = await buildReplacingDraft({
    oldSession: oldSess,
    preservedPastBatches,
    preservedPastFlexSlots,
    preservedPastEvents,
    reProposedActive: reProposed,
    newMutation,
    recipeDb: fakeRecipeDb,
    llm: throwingLLM,
    calorieTolerance: 20,
  });

  // Draft session: new id, same horizon, history extended.
  assert.notEqual(draft.id, 'old');
  assert.equal(draft.horizonStart, '2026-04-06');
  assert.equal(draft.horizonEnd, '2026-04-12');
  assert.deepStrictEqual(draft.mutationHistory, [
    { constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' },
    { constraint: 'eating out tonight', appliedAt: '2026-04-07T19:30:00.000Z' },
  ]);

  // Draft's flexSlots and events concatenate preserved past + re-proposed active.
  // Past first, then active — matches the order the round-trip wants.
  assert.deepStrictEqual(draft.flexSlots, [
    { day: '2026-04-05', mealTime: 'dinner', flexBonus: 350 },
    { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(draft.events, [
    { name: 'office lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'team lunch' },
  ]);

  // Batches: preserved past + new re-proposed active. Past batches get a
  // new createdInPlanSessionId pointing at the new draft, and a new id.
  assert.equal(newBatches.length, 2);

  const pastBatch = newBatches.find((b) => b.recipeSlug === 'grain-bowl');
  assert.ok(pastBatch, 'preserved past batch missing');
  assert.deepStrictEqual(pastBatch.eatingDays, ['2026-04-06', '2026-04-07']);
  assert.equal(pastBatch.servings, 2);
  assert.equal(pastBatch.createdInPlanSessionId, draft.id);
  assert.notEqual(pastBatch.id, 'past-grainbowl'); // new id
  assert.equal(pastBatch.status, 'planned');

  const activeBatch = newBatches.find((b) => b.recipeSlug === 'tagine');
  assert.ok(activeBatch, 'active re-proposed batch missing');
  assert.deepStrictEqual(activeBatch.eatingDays, ['2026-04-08', '2026-04-09']);
  assert.equal(activeBatch.servings, 2);
  assert.equal(activeBatch.createdInPlanSessionId, draft.id);
  assert.equal(activeBatch.mealType, 'dinner');
  // CRITICAL: targetPerServing must come from the solver's BatchTarget, NOT
  // from recipe.perServing.
  assert.deepStrictEqual(activeBatch.targetPerServing, { calories: 720, protein: 50 });
});

test('end-to-end: confirmed plan → adapter → re-proposer (stubbed) → replacing draft → store', async () => {
  // Setup: a confirmed plan with 2 dinner batches and 1 lunch batch, running
  // across a full 7-day horizon. Wall clock: Tuesday 7pm. Monday has fully
  // consumed slots; Tuesday lunch is past (after 15:00); Tuesday dinner is
  // still active (19:00 < 21:00 dinner cutoff).
  const { TestStateStore } = await import('../../src/harness/test-store.js');
  const store = new TestStateStore();
  const oldSessionId = 'old-session';
  const now = at('2026-04-07', 19);

  await store.confirmPlanSession(
    {
      id: oldSessionId,
      horizonStart: '2026-04-06',
      horizonEnd: '2026-04-12',
      breakfast: { locked: true, recipeSlug: 'oatmeal', caloriesPerDay: 450, proteinPerDay: 25 },
      treatBudgetCalories: 800,
      // Past flex slot (Monday dinner — already consumed by Tue 19:00) and
      // active flex slot (Saturday dinner). The past one must round-trip via
      // preservedPastFlexSlots, the active one via the re-proposer.
      flexSlots: [
        { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350, note: 'burger night' },
        { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
      ],
      // Past meal event (Monday lunch out) and active meal event (Friday lunch).
      events: [
        { name: 'team lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'sushi place' },
        { name: 'friend lunch', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 700 },
      ],
      mutationHistory: [{ constraint: 'initial plan', appliedAt: '2026-04-05T18:00:00.000Z' }],
    },
    [
      // Tagine dinner batch — Mon/Tue/Wed. At Tue 19:00 this is spanning:
      // Mon dinner past, Tue dinner active, Wed dinner active.
      batch({
        id: 'b-tagine',
        recipeSlug: 'tagine',
        mealType: 'dinner',
        eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
        servings: 3,
        createdInPlanSessionId: oldSessionId,
      }),
      // Grain-bowl lunch batch — Mon/Tue/Wed. At Tue 19:00 Mon lunch and Tue
      // lunch are past (19:00 > 15:00 cutoff), Wed lunch is active.
      batch({
        id: 'b-grain',
        recipeSlug: 'grain-bowl',
        mealType: 'lunch',
        eatingDays: ['2026-04-06', '2026-04-07', '2026-04-08'],
        servings: 3,
        createdInPlanSessionId: oldSessionId,
      }),
      // Chicken dinner batch — Thu/Fri/Sat. All active.
      batch({
        id: 'b-chicken',
        recipeSlug: 'chicken',
        mealType: 'dinner',
        eatingDays: ['2026-04-09', '2026-04-10', '2026-04-11'],
        servings: 3,
        createdInPlanSessionId: oldSessionId,
      }),
    ],
  );

  // 1. Load and run the forward adapter.
  const loaded = await store.getPlanSession(oldSessionId);
  assert.ok(loaded);
  const loadedBatches = await store.getBatchesByPlanSessionId(oldSessionId);
  const forward = sessionToPostConfirmationProposal(loaded, loadedBatches, now);

  // Sanity: near-future is [Tue, Wed].
  assert.deepStrictEqual(forward.nearFutureDays, ['2026-04-07', '2026-04-08']);

  // Sanity: preserved past includes the Mon tagine half, Mon+Tue grain-bowl halves.
  const pastSigs = forward.preservedPastBatches.map(
    (b) => `${b.recipeSlug}:${b.mealType}:${b.eatingDays.join(',')}`,
  ).sort();
  assert.deepStrictEqual(pastSigs, [
    'grain-bowl:lunch:2026-04-06,2026-04-07',
    'tagine:dinner:2026-04-06',
  ]);

  // Sanity: the Monday past flex slot and Monday past lunch event split into
  // preservedPast* arrays; the Saturday flex and Friday lunch event stay active.
  assert.deepStrictEqual(forward.preservedPastFlexSlots, [
    { day: '2026-04-06', mealTime: 'dinner', flexBonus: 350, note: 'burger night' },
  ]);
  assert.deepStrictEqual(forward.preservedPastEvents, [
    { name: 'team lunch out', day: '2026-04-06', mealTime: 'lunch', estimatedCalories: 850, notes: 'sushi place' },
  ]);
  assert.deepStrictEqual(forward.activeProposal.flexSlots, [
    { day: '2026-04-11', mealTime: 'dinner', flexBonus: 350 },
  ]);
  assert.deepStrictEqual(forward.activeProposal.events, [
    { name: 'friend lunch', day: '2026-04-10', mealTime: 'lunch', estimatedCalories: 700 },
  ]);

  // Sanity: active proposal has tagine (Tue,Wed/2), grain-bowl (Wed/1), chicken (Thu-Sat/3).
  const activeSigs = forward.activeProposal.batches.map(
    (b) => `${b.recipeSlug}:${b.mealType}:${b.days.join(',')}/${b.servings}`,
  ).sort();
  assert.deepStrictEqual(activeSigs, [
    'chicken:dinner:2026-04-09,2026-04-10,2026-04-11/3',
    'grain-bowl:lunch:2026-04-08/1',
    'tagine:dinner:2026-04-07,2026-04-08/2',
  ]);

  // 2. Stub the re-proposer output: simulate "eating out tonight" by dropping
  // the Tue tagine slot (keeping Wed), and adding an eat_out event on Tue
  // dinner. Chicken and grain-bowl unchanged. Events now include BOTH the
  // preserved active event (Friday friend lunch) from the forward adapter AND
  // the new eat-out. Attach a minimal solverOutput so buildReplacingDraft has
  // something to consume.
  const reProposedActive: PlanProposal = {
    batches: [
      {
        recipeSlug: 'grain-bowl', recipeName: 'grain-bowl', mealType: 'lunch',
        days: ['2026-04-08'], servings: 1, overflowDays: undefined,
      },
      {
        recipeSlug: 'tagine', recipeName: 'tagine', mealType: 'dinner',
        days: ['2026-04-08'], servings: 1, overflowDays: undefined,
      },
      {
        recipeSlug: 'chicken', recipeName: 'chicken', mealType: 'dinner',
        days: ['2026-04-09', '2026-04-10', '2026-04-11'], servings: 3, overflowDays: undefined,
      },
    ],
    flexSlots: forward.activeProposal.flexSlots,
    events: [
      ...forward.activeProposal.events,
      { name: 'dinner with friends', day: '2026-04-07', mealTime: 'dinner', estimatedCalories: 900 },
    ],
    recipesToGenerate: [],
    solverOutput: {
      isValid: true,
      weeklyTotals: { calories: 15000, protein: 900, treatBudget: 800, flexSlotCalories: 350 },
      dailyBreakdown: [],
      batchTargets: [
        {
          id: 'bt-grain',
          recipeSlug: 'grain-bowl',
          mealType: 'lunch',
          days: ['2026-04-08'],
          servings: 1,
          targetPerServing: { calories: 600, protein: 35 },
        },
        {
          id: 'bt-tagine',
          recipeSlug: 'tagine',
          mealType: 'dinner',
          days: ['2026-04-08'],
          servings: 1,
          targetPerServing: { calories: 720, protein: 48 },
        },
        {
          id: 'bt-chicken',
          recipeSlug: 'chicken',
          mealType: 'dinner',
          days: ['2026-04-09', '2026-04-10', '2026-04-11'],
          servings: 3,
          targetPerServing: { calories: 700, protein: 50 },
        },
      ],
      cookingSchedule: [],
      warnings: [],
    },
  };

  // 3. Run the round-trip back. Pass preserved past flex slots + events through
  // as well — the end-to-end contract is "past state round-trips verbatim".
  const { draft, batches: newBatches } = await buildReplacingDraft({
    oldSession: loaded,
    preservedPastBatches: forward.preservedPastBatches,
    preservedPastFlexSlots: forward.preservedPastFlexSlots,
    preservedPastEvents: forward.preservedPastEvents,
    reProposedActive,
    newMutation: { constraint: 'eating out tonight', appliedAt: '2026-04-07T19:30:00.000Z' },
    recipeDb: fakeRecipeDb,
    llm: throwingLLM,
    calorieTolerance: 20,
  });

  // 4. Write via confirmPlanSessionReplacing.
  const persisted = await store.confirmPlanSessionReplacing(draft, newBatches, oldSessionId);

  // 5. Assert final store state.
  // Old session superseded.
  const oldReloaded = await store.getPlanSession(oldSessionId);
  assert.ok(oldReloaded);
  assert.equal(oldReloaded.superseded, true);

  // New session active, mutationHistory = [initial plan, eating out tonight].
  assert.equal(persisted.superseded, false);
  assert.equal(persisted.mutationHistory.length, 2);
  assert.equal(persisted.mutationHistory[1]!.constraint, 'eating out tonight');

  // New session flexSlots: past (Mon burger night) + active (Sat flex).
  assert.equal(persisted.flexSlots.length, 2);
  assert.deepStrictEqual(
    persisted.flexSlots.map((f) => `${f.day}:${f.mealTime}`).sort(),
    ['2026-04-06:dinner', '2026-04-11:dinner'],
  );
  const pastFlex = persisted.flexSlots.find((f) => f.day === '2026-04-06');
  assert.equal(pastFlex?.note, 'burger night', 'past flex slot metadata must survive');

  // New session events: past (Mon team lunch) + preserved active (Fri friend
  // lunch carried through the re-proposer) + newly-added (Tue dinner out).
  assert.equal(persisted.events.length, 3);
  const eventSigs = persisted.events.map((e) => `${e.day}:${e.mealTime}:${e.name}`).sort();
  assert.deepStrictEqual(eventSigs, [
    '2026-04-06:lunch:team lunch out',
    '2026-04-07:dinner:dinner with friends',
    '2026-04-10:lunch:friend lunch',
  ]);
  const pastEvent = persisted.events.find((e) => e.day === '2026-04-06');
  assert.equal(pastEvent?.estimatedCalories, 850, 'past event calories must survive');
  assert.equal(pastEvent?.notes, 'sushi place', 'past event notes must survive');

  // New session's batches under the new id include: the preserved past
  // halves + the re-proposed active batches. Old batches still exist but
  // with status='cancelled' on the old session.
  const newBatchesReloaded = await store.getBatchesByPlanSessionId(persisted.id);
  const newSigs = newBatchesReloaded.map(
    (b) => `${b.recipeSlug}:${b.mealType}:${b.eatingDays.join(',')}:${b.status}`,
  ).sort();
  assert.deepStrictEqual(newSigs, [
    'chicken:dinner:2026-04-09,2026-04-10,2026-04-11:planned',
    'grain-bowl:lunch:2026-04-06,2026-04-07:planned',
    'grain-bowl:lunch:2026-04-08:planned',
    'tagine:dinner:2026-04-06:planned',
    'tagine:dinner:2026-04-08:planned',
  ]);

  const oldBatchesReloaded = await store.getBatchesByPlanSessionId(oldSessionId);
  assert.ok(oldBatchesReloaded.every((b) => b.status === 'cancelled'));
});

test('buildReplacingDraft: throws when reProposedActive.solverOutput is missing', async () => {
  const reProposedWithoutSolver: PlanProposal = {
    batches: [
      {
        recipeSlug: 'tagine', recipeName: 'tagine', mealType: 'dinner',
        days: ['2026-04-08'], servings: 1, overflowDays: undefined,
      },
    ],
    flexSlots: [],
    events: [],
    recipesToGenerate: [],
    // solverOutput deliberately omitted — caller forgot to run the solver.
  };
  await assert.rejects(
    () => buildReplacingDraft({
      oldSession: session({ id: 'old' }),
      preservedPastBatches: [],
      preservedPastFlexSlots: [],
      preservedPastEvents: [],
      reProposedActive: reProposedWithoutSolver,
      newMutation: { constraint: 'x', appliedAt: '2026-04-08T12:00:00.000Z' },
      recipeDb: fakeRecipeDb,
      llm: throwingLLM,
    }),
    /solverOutput is missing/,
  );
});
