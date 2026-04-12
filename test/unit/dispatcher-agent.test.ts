/**
 * Unit tests for the pure dispatcher agent — Plan 028.
 *
 * Exercises dispatchMessage against a FakeLLMProvider that returns
 * pre-canned JSON responses. Covers happy path per action, parse failure
 * with successful retry, parse failure with failed retry (DispatcherFailure),
 * disallowed-action rejection with successful retry, and the per-action
 * response-field validation rules.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  dispatchMessage,
  DispatcherFailure,
  AVAILABLE_ACTIONS_V0_0_5,
  type DispatcherContext,
  type DispatcherDecision,
} from '../../src/agents/dispatcher.js';
import type {
  LLMProvider,
  CompletionOptions,
  CompletionResult,
} from '../../src/ai/provider.js';

/**
 * Minimal stub provider — returns a pre-queued list of responses in order.
 * Each entry corresponds to one `complete` call. If the queue runs out, the
 * stub throws.
 */
function stubLLM(responses: string[]): LLMProvider {
  const queue = [...responses];
  return {
    async complete(_: CompletionOptions): Promise<CompletionResult> {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('stubLLM: unexpected additional complete() call');
      }
      return { content: next, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async transcribe(): Promise<string> {
      throw new Error('stubLLM: transcribe not supported in dispatcher tests');
    },
  };
}

function baseContext(overrides: Partial<DispatcherContext> = {}): DispatcherContext {
  return {
    today: '2026-04-10',
    now: '2026-04-10T12:00:00.000Z',
    surface: null,
    lifecycle: 'no_plan',
    activeFlow: { kind: 'none' },
    recentTurns: [],
    planSummary: null,
    recipeIndex: [],
    allowedActions: AVAILABLE_ACTIONS_V0_0_5,
    ...overrides,
  };
}

test('dispatchMessage: flow_input happy path', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'flow_input',
      params: {},
      response: null,
      reasoning: 'Event text during awaiting_events.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({
      activeFlow: { kind: 'plan', phase: 'awaiting_events' },
      lifecycle: 'planning',
    }),
    'dinner out on Friday',
    llm,
  );
  assert.equal(decision.action, 'flow_input');
  assert.deepStrictEqual(decision.params, {});
  assert.equal(decision.response, undefined);
  assert.match(decision.reasoning, /Event text/);
});

test('dispatchMessage: clarify happy path with response string', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'Do you mean lunch or dinner?',
      reasoning: 'Meal time ambiguous.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'I went to the Indian place', llm);
  assert.equal(decision.action, 'clarify');
  assert.equal(
    (decision as Extract<DispatcherDecision, { action: 'clarify' }>).response,
    'Do you mean lunch or dinner?',
  );
});

test('dispatchMessage: out_of_scope carries category and response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'out_of_scope',
      params: { category: 'weather' },
      response: "I help with meal planning, recipes, and nutrition — not weather.",
      reasoning: 'Clearly out of domain.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), "what's the weather today?", llm);
  assert.equal(decision.action, 'out_of_scope');
  const dec = decision as Extract<DispatcherDecision, { action: 'out_of_scope' }>;
  assert.equal(dec.params.category, 'weather');
  assert.match(dec.response, /not weather/);
});

test('dispatchMessage: return_to_flow happy path with null response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'return_to_flow',
      params: {},
      response: null,
      reasoning: 'User wants to resume planning.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({
      activeFlow: { kind: 'plan', phase: 'proposal' },
      lifecycle: 'planning',
    }),
    'ok back to the plan',
    llm,
  );
  assert.equal(decision.action, 'return_to_flow');
});

test('dispatchMessage: first-pass JSON parse error → retries and succeeds', async () => {
  const llm = stubLLM([
    'not json at all',
    JSON.stringify({
      action: 'out_of_scope',
      params: {},
      response: 'I help with meal planning only.',
      reasoning: 'Out of domain (after retry).',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'xyz', llm);
  assert.equal(decision.action, 'out_of_scope');
});

test('dispatchMessage: first-pass disallowed action → retries and succeeds', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_eating_out',
      params: { description: 'Indian restaurant', meal_time: 'dinner', day: 'today' },
      response: null,
      reasoning: 'User described eating out — would route to log_eating_out if available.',
    }),
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'I went out for Indian for dinner' },
      response: null,
      reasoning: 'Honest fallback after disallowed-action retry — Plan D handles eating-out via mutate_plan.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext({ lifecycle: 'active_mid' }), 'I went out for Indian for dinner', llm);
  assert.equal(decision.action, 'mutate_plan');
});

test('dispatchMessage: clarify without response field → retry → succeeds', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: null,
      reasoning: 'No question authored (invalid).',
    }),
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'What would you like to do?',
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'hmm', llm);
  assert.equal(decision.action, 'clarify');
});

test('dispatchMessage: both attempts fail → DispatcherFailure', async () => {
  const llm = stubLLM(['total garbage', '{"action":"nonsense"}']);
  await assert.rejects(
    () => dispatchMessage(baseContext(), 'x', llm),
    (err) => err instanceof DispatcherFailure,
  );
});

test('dispatchMessage: flow_input with non-null response is rejected', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'flow_input',
      params: {},
      response: 'This should not be here.',
      reasoning: 'Invalid.',
    }),
    JSON.stringify({
      action: 'flow_input',
      params: {},
      response: null,
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({
      activeFlow: { kind: 'plan', phase: 'awaiting_events' },
    }),
    'dinner Friday',
    llm,
  );
  assert.equal(decision.action, 'flow_input');
});

// ─── Plan 029: mutate_plan tests ──────────────────────────────────────────────

test('dispatchMessage: mutate_plan carries the request param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: "I'm eating out tonight, friend invited me" },
      response: null,
      reasoning: 'Real-life deviation on a confirmed plan.',
    }),
  ]);
  const decision = await dispatchMessage(
    baseContext({ lifecycle: 'active_mid', surface: 'plan' }),
    "I'm eating out tonight, friend invited me",
    llm,
  );
  assert.equal(decision.action, 'mutate_plan');
  const dec = decision as Extract<DispatcherDecision, { action: 'mutate_plan' }>;
  assert.equal(dec.params.request, "I'm eating out tonight, friend invited me");
});

test('dispatchMessage: mutate_plan with empty request is rejected on first pass', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: '' },
      response: null,
      reasoning: 'Empty request — invalid.',
    }),
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move the flex to Sunday' },
      response: null,
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'move the flex to Sunday', llm);
  assert.equal(decision.action, 'mutate_plan');
});

test('dispatchMessage: mutate_plan with non-null response is rejected on first pass', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move flex' },
      response: 'The mutation has been applied.',
      reasoning: 'Invalid — mutate_plan is handler-rendered.',
    }),
    JSON.stringify({
      action: 'mutate_plan',
      params: { request: 'move the flex to Sunday' },
      response: null,
      reasoning: 'Corrected.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'move flex', llm);
  assert.equal(decision.action, 'mutate_plan');
});

// ─── Plan 030: Plan E secondary action tests ─────────────────────────────────

test('dispatchMessage: answer_plan_question with question + response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: "when's my next cook day?" },
      response: 'Thursday — you cook the Greek lemon chicken batch.',
      reasoning: 'Mechanical lookup from plan summary.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), "when's my next cook day?", llm);
  assert.equal(decision.action, 'answer_plan_question');
  if (decision.action !== 'answer_plan_question') throw new Error('unreachable');
  assert.match(decision.response, /Thursday/);
});

test('dispatchMessage: answer_plan_question without response is rejected', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: 'X?' },
      response: null,
      reasoning: 'Invalid — missing response.',
    }),
    JSON.stringify({
      action: 'answer_plan_question',
      params: { question: 'X?' },
      response: 'Corrected answer.',
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'X?', llm);
  assert.equal(decision.action, 'answer_plan_question');
});

test('dispatchMessage: answer_recipe_question with recipe_slug', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_recipe_question',
      params: { question: 'can I freeze this?', recipe_slug: 'tagine' },
      response: 'Yes — beef tagine freezes well.',
      reasoning: 'Recipe index shows freezable=true.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'can I freeze this?', llm);
  assert.equal(decision.action, 'answer_recipe_question');
  if (decision.action !== 'answer_recipe_question') throw new Error('unreachable');
  assert.equal(decision.params.recipe_slug, 'tagine');
  assert.match(decision.response, /freezes/);
});

test('dispatchMessage: answer_recipe_question without recipe_slug (generic)', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_recipe_question',
      params: { question: 'what substitutes for tahini?' },
      response: 'Cashew butter or sunflower seed butter both work.',
      reasoning: 'Generic substitution question with no specific recipe.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'what substitutes for tahini in a recipe?', llm);
  assert.equal(decision.action, 'answer_recipe_question');
  if (decision.action !== 'answer_recipe_question') throw new Error('unreachable');
  assert.equal(decision.params.recipe_slug, undefined);
});

test('dispatchMessage: answer_domain_question with response', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'answer_domain_question',
      params: { question: 'how much protein in 100g chicken?' },
      response: 'About 31g of protein per 100g of cooked chicken breast.',
      reasoning: 'General nutrition question.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'how much protein in 100g chicken?', llm);
  assert.equal(decision.action, 'answer_domain_question');
  if (decision.action !== 'answer_domain_question') throw new Error('unreachable');
  assert.match(decision.response, /protein/);
});

test('dispatchMessage: show_recipe with recipe_slug param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_recipe',
      params: { recipe_slug: 'tagine' },
      response: null,
      reasoning: 'User asked to see the tagine.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'show me the tagine', llm);
  assert.equal(decision.action, 'show_recipe');
  if (decision.action !== 'show_recipe') throw new Error('unreachable');
  assert.equal(decision.params.recipe_slug, 'tagine');
});

test('dispatchMessage: show_recipe without recipe_slug is rejected', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_recipe',
      params: {},
      response: null,
      reasoning: 'Missing slug.',
    }),
    JSON.stringify({
      action: 'show_recipe',
      params: { recipe_slug: 'tagine' },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'show me the tagine', llm);
  assert.equal(decision.action, 'show_recipe');
});

test('dispatchMessage: show_plan with day_detail requires day param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_plan',
      params: { screen: 'day_detail' },
      response: null,
      reasoning: 'Missing day.',
    }),
    JSON.stringify({
      action: 'show_plan',
      params: { screen: 'day_detail', day: '2026-04-09' },
      response: null,
      reasoning: 'Fixed with explicit day.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'what is Thursday looking like', llm);
  assert.equal(decision.action, 'show_plan');
  if (decision.action !== 'show_plan') throw new Error('unreachable');
  assert.equal(decision.params.screen, 'day_detail');
  assert.equal(decision.params.day, '2026-04-09');
});

test('dispatchMessage: show_plan week_overview happy path', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_plan',
      params: { screen: 'week_overview' },
      response: null,
      reasoning: 'User wants the full week.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'show me the whole plan', llm);
  assert.equal(decision.action, 'show_plan');
  if (decision.action !== 'show_plan') throw new Error('unreachable');
  assert.equal(decision.params.screen, 'week_overview');
  assert.equal(decision.params.day, undefined);
});

test('dispatchMessage: show_shopping_list scope=recipe requires recipe_slug', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'recipe' },
      response: null,
      reasoning: 'Missing recipe_slug.',
    }),
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'recipe', recipe_slug: 'tagine' },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'shopping list for the tagine', llm);
  assert.equal(decision.action, 'show_shopping_list');
  if (decision.action !== 'show_shopping_list') throw new Error('unreachable');
  assert.equal(decision.params.scope, 'recipe');
  assert.equal(decision.params.recipe_slug, 'tagine');
});

test('dispatchMessage: show_shopping_list scope=full_week happy path', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'full_week' },
      response: null,
      reasoning: 'Full week shopping.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'full shopping list for the week', llm);
  assert.equal(decision.action, 'show_shopping_list');
  if (decision.action !== 'show_shopping_list') throw new Error('unreachable');
  assert.equal(decision.params.scope, 'full_week');
});

test('dispatchMessage: show_shopping_list scope=day requires day param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'day' },
      response: null,
      reasoning: 'Missing day.',
    }),
    JSON.stringify({
      action: 'show_shopping_list',
      params: { scope: 'day', day: '2026-04-10' },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'shopping for Friday', llm);
  assert.equal(decision.action, 'show_shopping_list');
  if (decision.action !== 'show_shopping_list') throw new Error('unreachable');
  assert.equal(decision.params.scope, 'day');
  assert.equal(decision.params.day, '2026-04-10');
});

test('dispatchMessage: show_progress with view param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_progress',
      params: { view: 'weekly_report' },
      response: null,
      reasoning: 'Weekly report request.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'show me the weekly report', llm);
  assert.equal(decision.action, 'show_progress');
  if (decision.action !== 'show_progress') throw new Error('unreachable');
  assert.equal(decision.params.view, 'weekly_report');
});

test('dispatchMessage: show_progress with invalid view is rejected', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'show_progress',
      params: { view: 'invalid_view' },
      response: null,
      reasoning: 'Invalid view.',
    }),
    JSON.stringify({
      action: 'show_progress',
      params: { view: 'log_prompt' },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'log my weight', llm);
  assert.equal(decision.action, 'show_progress');
});

test('dispatchMessage: log_measurement requires at least one numeric param', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_measurement',
      params: {},
      response: null,
      reasoning: 'Empty.',
    }),
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 82.3 },
      response: null,
      reasoning: 'Fixed with weight.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), '82.3 today', llm);
  assert.equal(decision.action, 'log_measurement');
  if (decision.action !== 'log_measurement') throw new Error('unreachable');
  assert.equal(decision.params.weight, 82.3);
});

test('dispatchMessage: log_measurement with both weight and waist', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 82.3, waist: 91 },
      response: null,
      reasoning: 'Weight and waist from "82.3 / 91".',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), '82.3 / 91', llm);
  assert.equal(decision.action, 'log_measurement');
  if (decision.action !== 'log_measurement') throw new Error('unreachable');
  assert.equal(decision.params.weight, 82.3);
  assert.equal(decision.params.waist, 91);
});

test('dispatchMessage: log_measurement rejects out-of-range weight', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 999 },
      response: null,
      reasoning: 'Out of range.',
    }),
    JSON.stringify({
      action: 'log_measurement',
      params: { weight: 82.3 },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), '999 today', llm);
  assert.equal(decision.action, 'log_measurement');
  if (decision.action !== 'log_measurement') throw new Error('unreachable');
  assert.equal(decision.params.weight, 82.3);
});

test('dispatchMessage: log_measurement rejects out-of-range waist', async () => {
  const llm = stubLLM([
    JSON.stringify({
      action: 'log_measurement',
      params: { waist: 400 },
      response: null,
      reasoning: 'Out of range.',
    }),
    JSON.stringify({
      action: 'log_measurement',
      params: { waist: 91 },
      response: null,
      reasoning: 'Fixed.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'waist 400', llm);
  assert.equal(decision.action, 'log_measurement');
  if (decision.action !== 'log_measurement') throw new Error('unreachable');
  assert.equal(decision.params.waist, 91);
});
