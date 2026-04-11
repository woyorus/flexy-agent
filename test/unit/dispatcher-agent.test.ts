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
      action: 'mutate_plan',
      params: { request: 'move flex' },
      response: null,
      reasoning: 'User wants mutation (but mutate_plan is not allowed in v0.0.5).',
    }),
    JSON.stringify({
      action: 'clarify',
      params: {},
      response: 'Plan changes after confirmation are coming soon.',
      reasoning: 'Honest deferral.',
    }),
  ]);
  const decision = await dispatchMessage(baseContext(), 'move my flex', llm);
  assert.equal(decision.action, 'clarify');
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
