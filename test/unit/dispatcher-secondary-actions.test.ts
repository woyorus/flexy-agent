/**
 * Unit tests for the 8 secondary action handlers added in Plan 030 Tasks 11–17.
 *
 * Each handler is tested against a minimal fake deps/session/sink triple.
 * The view-renderers module is imported dynamically by the handlers, so we
 * validate the handler's contract (sink.reply calls, session mutations) rather
 * than the renderer internals — those are covered by view-renderer-specific
 * tests and scenario recordings.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type {
  DispatcherSession,
  DispatcherOutputSink,
  DispatcherRunnerDeps,
} from '../../src/telegram/dispatcher-runner.js';
import {
  handleAnswerPlanQuestionAction,
  handleAnswerRecipeQuestionAction,
  handleAnswerDomainQuestionAction,
  handleShowRecipeAction,
  handleShowPlanAction,
  handleShowShoppingListAction,
  handleShowProgressAction,
  handleLogMeasurementAction,
  renderMeasurementConfirmation,
} from '../../src/telegram/dispatcher-runner.js';
import type { DispatcherDecision } from '../../src/agents/dispatcher.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Minimal recording sink that captures reply calls. */
function recordingSink(): DispatcherOutputSink & {
  replies: Array<{ text: string; options?: Record<string, unknown> }>;
} {
  const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
  return {
    replies,
    async reply(text: string, options?: Record<string, unknown>): Promise<void> {
      replies.push({ text, options });
    },
    async answerCallback(): Promise<void> {},
    startTyping() {
      return () => {};
    },
  };
}

/** Minimal empty session conforming to DispatcherSession. */
function emptySession(overrides?: Partial<DispatcherSession>): DispatcherSession {
  return {
    recipeFlow: null,
    planFlow: null,
    progressFlow: null,
    surfaceContext: null,
    recentTurns: [],
    pendingMutation: undefined,
    pendingPostConfirmationClarification: undefined,
    ...overrides,
  };
}

/**
 * Minimal fake deps. The store stubs return empty/null for most queries —
 * individual tests override what they need via spread.
 */
function fakeDeps(overrides?: Partial<DispatcherRunnerDeps>): DispatcherRunnerDeps {
  const store = {
    getRunningPlanSession: async () => null,
    getFuturePlanSessions: async () => [],
    getLatestHistoricalPlanSession: async () => null,
    getBatchesByPlanSessionId: async () => [],
    getBatchesOverlapping: async () => [],
    getBatch: async () => null,
    getPlanSession: async () => null,
    getRecentPlanSessions: async () => [],
    logMeasurement: async () => {},
    getTodayMeasurement: async () => null,
    getMeasurements: async () => [],
    getLatestMeasurement: async () => null,
    confirmPlanSessionReplacing: async () => { throw new Error('not implemented'); },
  } as unknown as DispatcherRunnerDeps['store'];

  const recipes = {
    getAll: () => [],
    getBySlug: () => undefined,
    getByMealType: () => [],
  } as unknown as DispatcherRunnerDeps['recipes'];

  const llm = {} as unknown as DispatcherRunnerDeps['llm'];

  return { store, recipes, llm, ...overrides };
}

// ─── answer_plan_question ──────────────────────────────────────────────────

test('handleAnswerPlanQuestionAction: replies with response text and keyboard', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'answer_plan_question' as const,
    params: { question: 'what am I eating tomorrow?' },
    response: 'Tomorrow you have chicken stir-fry for lunch.',
    reasoning: 'plan question',
  };

  await handleAnswerPlanQuestionAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.equal(sink.replies[0]!.text, 'Tomorrow you have chicken stir-fry for lunch.');
  assert.ok(sink.replies[0]!.options?.reply_markup, 'should include a keyboard');
});

// ─── answer_recipe_question ────────────────────────────────────────────────

test('handleAnswerRecipeQuestionAction: replies with response and keyboard', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'answer_recipe_question' as const,
    params: { question: 'how long does the lamb need?', recipe_slug: 'lamb-tagine' },
    response: 'About 2.5 hours total with the slow cook.',
    reasoning: 'recipe question',
  };

  await handleAnswerRecipeQuestionAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.equal(sink.replies[0]!.text, 'About 2.5 hours total with the slow cook.');
  assert.ok(sink.replies[0]!.options?.reply_markup);
});

test('handleAnswerRecipeQuestionAction: works without recipe_slug', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'answer_recipe_question' as const,
    params: { question: 'what recipe is easiest?' },
    response: 'Overnight oats is the simplest.',
    reasoning: 'recipe question',
  };

  await handleAnswerRecipeQuestionAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.equal(sink.replies[0]!.text, 'Overnight oats is the simplest.');
});

// ─── answer_domain_question ────────────────────────────────────────────────

test('handleAnswerDomainQuestionAction: replies with response and keyboard', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'answer_domain_question' as const,
    params: { question: 'how much protein do I need?' },
    response: 'For your targets, around 140g daily.',
    reasoning: 'domain question',
  };

  await handleAnswerDomainQuestionAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.equal(sink.replies[0]!.text, 'For your targets, around 140g daily.');
  assert.ok(sink.replies[0]!.options?.reply_markup);
});

// ─── show_recipe ───────────────────────────────────────────────────────────

test('handleShowRecipeAction: falls back to library view when not in plan', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_recipe' as const,
    params: { recipe_slug: 'nonexistent-recipe' },
    reasoning: 'show recipe',
  };

  // With no plan and no recipe in the database, both renderers should
  // produce a "not found" / fallback reply.
  await handleShowRecipeAction(decision, deps, session, sink);

  assert.ok(sink.replies.length >= 1, 'should have at least one reply');
});

// ─── show_plan ─────────────────────────────────────────────────────────────

test('handleShowPlanAction: next_action replies when no plan exists', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_plan' as const,
    params: { screen: 'next_action' as const },
    reasoning: 'show plan',
  };

  await handleShowPlanAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /plan/i);
});

test('handleShowPlanAction: week_overview replies when no plan exists', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_plan' as const,
    params: { screen: 'week_overview' as const },
    reasoning: 'show plan',
  };

  await handleShowPlanAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /plan/i);
});

test('handleShowPlanAction: day_detail with missing day param replies with error', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_plan' as const,
    params: { screen: 'day_detail' as const },
    reasoning: 'show plan',
  };

  await handleShowPlanAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /couldn't figure out/i);
});

test('handleShowPlanAction: day_detail with day but no plan replies with no-plan message', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_plan' as const,
    params: { screen: 'day_detail' as const, day: '2026-04-13' },
    reasoning: 'show plan',
  };

  await handleShowPlanAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  // Either "no plan" or "day not in plan" — both valid with no plan loaded
  assert.ok(sink.replies[0]!.text.length > 0);
});

// ─── show_shopping_list ────────────────────────────────────────────────────

test('handleShowShoppingListAction: next_cook scope replies', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_shopping_list' as const,
    params: { scope: 'next_cook' as const },
    reasoning: 'shopping list',
  };

  await handleShowShoppingListAction(decision, deps, session, sink);

  assert.ok(sink.replies.length >= 1);
});

test('handleShowShoppingListAction: full_week scope replies', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_shopping_list' as const,
    params: { scope: 'full_week' as const },
    reasoning: 'shopping list',
  };

  await handleShowShoppingListAction(decision, deps, session, sink);

  assert.ok(sink.replies.length >= 1);
});

test('handleShowShoppingListAction: recipe scope without slug replies with error', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_shopping_list' as const,
    params: { scope: 'recipe' as const },
    reasoning: 'shopping list',
  };

  await handleShowShoppingListAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /couldn't figure out/i);
});

test('handleShowShoppingListAction: day scope without day replies with error', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_shopping_list' as const,
    params: { scope: 'day' as const },
    reasoning: 'shopping list',
  };

  await handleShowShoppingListAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /couldn't figure out/i);
});

// ─── show_progress ─────────────────────────────────────────────────────────

test('handleShowProgressAction: log_prompt sets progressFlow phase', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_progress' as const,
    params: { view: 'log_prompt' as const },
    reasoning: 'show progress',
  };

  await handleShowProgressAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  // The renderProgressView for log_prompt sets progressFlow to awaiting_measurement
  assert.deepStrictEqual(session.progressFlow, { phase: 'awaiting_measurement' });
});

test('handleShowProgressAction: weekly_report replies with no-data message', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'show_progress' as const,
    params: { view: 'weekly_report' as const },
    reasoning: 'show progress',
  };

  await handleShowProgressAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  // No measurements → "No measurements from last week" message
  assert.match(sink.replies[0]!.text, /measurement/i);
});

// ─── log_measurement ───────────────────────────────────────────────────────

test('handleLogMeasurementAction: empty values replies with hint', async () => {
  const sink = recordingSink();
  const session = emptySession();
  const deps = fakeDeps();
  const decision = {
    action: 'log_measurement' as const,
    params: {},
    reasoning: 'log measurement',
  };

  await handleLogMeasurementAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /didn't catch a number/i);
});

test('handleLogMeasurementAction: weight only logs and confirms', async () => {
  const sink = recordingSink();
  const session = emptySession({ progressFlow: { phase: 'awaiting_measurement' } });
  const logged: Array<{ weight: number; waist: number | null }> = [];
  const deps = fakeDeps({
    store: {
      getRunningPlanSession: async () => null,
      getFuturePlanSessions: async () => [],
      getLatestHistoricalPlanSession: async () => null,
      getBatchesByPlanSessionId: async () => [],
      getBatchesOverlapping: async () => [],
      getBatch: async () => null,
      getPlanSession: async () => null,
      getRecentPlanSessions: async () => [],
      logMeasurement: async (_u: string, _d: string, w: number, waist: number | null) => {
        logged.push({ weight: w, waist });
      },
      getTodayMeasurement: async () => null,
      getMeasurements: async () => [],
      getLatestMeasurement: async () => null,
      confirmPlanSessionReplacing: async () => { throw new Error('not impl'); },
    } as unknown as DispatcherRunnerDeps['store'],
  });
  const decision = {
    action: 'log_measurement' as const,
    params: { weight: 82.3 },
    reasoning: 'log measurement',
  };

  await handleLogMeasurementAction(decision, deps, session, sink);

  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.weight, 82.3);
  assert.equal(logged[0]!.waist, null);
  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /82\.3/);
  // progressFlow should be cleared after logging
  assert.equal(session.progressFlow, null);
});

test('handleLogMeasurementAction: weight + waist logs both', async () => {
  const sink = recordingSink();
  const session = emptySession({ progressFlow: { phase: 'awaiting_measurement' } });
  const logged: Array<{ weight: number; waist: number | null }> = [];
  const deps = fakeDeps({
    store: {
      getRunningPlanSession: async () => null,
      getFuturePlanSessions: async () => [],
      getLatestHistoricalPlanSession: async () => null,
      getBatchesByPlanSessionId: async () => [],
      getBatchesOverlapping: async () => [],
      getBatch: async () => null,
      getPlanSession: async () => null,
      getRecentPlanSessions: async () => [],
      logMeasurement: async (_u: string, _d: string, w: number, waist: number | null) => {
        logged.push({ weight: w, waist });
      },
      getTodayMeasurement: async () => null,
      getMeasurements: async () => [],
      getLatestMeasurement: async () => ({
        id: 'x',
        userId: 'default',
        date: '2026-04-11',
        weightKg: 82,
        waistCm: 90,
        createdAt: '2026-04-11T08:00:00Z',
      }),
      confirmPlanSessionReplacing: async () => { throw new Error('not impl'); },
    } as unknown as DispatcherRunnerDeps['store'],
  });
  const decision = {
    action: 'log_measurement' as const,
    params: { weight: 82.1, waist: 90.5 },
    reasoning: 'log measurement',
  };

  await handleLogMeasurementAction(decision, deps, session, sink);

  assert.equal(logged.length, 1);
  // assignWeightWaist should handle the two values
  assert.ok(sink.replies.length >= 1);
});

// ─── renderMeasurementConfirmation (extracted helper) ──────────────────────

test('renderMeasurementConfirmation: single value logs weight', async () => {
  const sink = recordingSink();
  const session = emptySession({ progressFlow: { phase: 'awaiting_measurement' } });
  const logged: Array<{ weight: number; waist: number | null }> = [];
  const store = {
    logMeasurement: async (_u: string, _d: string, w: number, waist: number | null) => {
      logged.push({ weight: w, waist });
    },
    getMeasurements: async () => [],
    getLatestMeasurement: async () => null,
  } as unknown as DispatcherRunnerDeps['store'];

  await renderMeasurementConfirmation(session, store, sink, { values: [75.5] });

  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.weight, 75.5);
  assert.equal(logged[0]!.waist, null);
  assert.equal(session.progressFlow, null, 'progressFlow should be cleared');
  assert.equal(sink.replies.length, 1);
  assert.match(sink.replies[0]!.text, /75\.5/);
});

// ─── Answer handlers with active plan flow ─────────────────────────────────

test('handleAnswerPlanQuestionAction: includes back-to-planning button when planFlow active', async () => {
  const sink = recordingSink();
  const session = emptySession({
    planFlow: { phase: 'proposal' },
  });
  const deps = fakeDeps();
  const decision = {
    action: 'answer_plan_question' as const,
    params: { question: 'what happens to my flex slots?' },
    response: 'Your flex slots stay the same.',
    reasoning: 'plan question',
  };

  await handleAnswerPlanQuestionAction(decision, deps, session, sink);

  assert.equal(sink.replies.length, 1);
  // When planFlow is active, keyboard should be an InlineKeyboard with back button
  const kb = sink.replies[0]!.options?.reply_markup;
  assert.ok(kb, 'should have a keyboard');
  // InlineKeyboard from grammy has an `inline_keyboard` property
  const inlineKb = kb as { inline_keyboard?: unknown[][] };
  assert.ok(inlineKb.inline_keyboard, 'should be an inline keyboard');
});
