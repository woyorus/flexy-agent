/**
 * Unit tests for `FixtureLLMProvider` and `hashRequest`.
 *
 * Verifies:
 *   - happy path: recorded fixture is returned for a matching request
 *   - missing fixture: throws `MissingFixtureError` with nearest suggestions
 *   - hash coverage: `json` and `maxTokens` are part of the key, so two
 *     otherwise-identical requests with different values produce different
 *     hashes and cannot collide (the exact collision the harness exists
 *     to prevent)
 *   - stable key ordering: identical logical requests hash identically
 *     regardless of property insertion order
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FixtureLLMProvider,
  hashRequest,
  MissingFixtureError,
  type LLMFixture,
} from '../../src/ai/fixture.js';
import type { CompletionOptions } from '../../src/ai/provider.js';

function makeOptions(overrides: Partial<CompletionOptions> = {}): CompletionOptions {
  return {
    model: 'mini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello world' },
    ],
    ...overrides,
  };
}

function makeFixture(options: CompletionOptions, response: string, callIndex = 1): LLMFixture {
  return {
    hash: hashRequest(options),
    callIndex,
    model: options.model,
    reasoning: options.reasoning,
    json: options.json,
    maxTokens: options.maxTokens,
    messages: options.messages,
    response,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

test('FixtureLLMProvider returns the matching fixture for a recorded request', async () => {
  const opts = makeOptions();
  const provider = new FixtureLLMProvider([makeFixture(opts, 'hi there')]);
  const result = await provider.complete(opts);
  assert.equal(result.content, 'hi there');
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 20);
});

test('FixtureLLMProvider throws MissingFixtureError with nearest candidates', async () => {
  const recorded = makeFixture(
    makeOptions({ messages: [{ role: 'user', content: 'What is the weather in Paris?' }] }),
    'Sunny',
  );
  const provider = new FixtureLLMProvider([recorded]);

  const missing = makeOptions({
    messages: [{ role: 'user', content: 'What is the weather in London?' }],
  });
  await assert.rejects(
    () => provider.complete(missing),
    (err: unknown) => {
      assert.ok(err instanceof MissingFixtureError, 'expected MissingFixtureError');
      const e = err as MissingFixtureError;
      assert.ok(e.nearest.length >= 1, 'should surface at least one nearest fixture');
      assert.ok(
        e.nearest[0]?.lastUserMessage.includes('Paris'),
        'nearest fixture should be the Paris one — only recorded entry',
      );
      assert.ok(
        e.message.includes('npm run test:generate'),
        'error message must include the regenerate command',
      );
      return true;
    },
  );
});

test('hashRequest differentiates json:true from json:false with otherwise-identical requests', () => {
  // This is the exact collision the harness exists to prevent: two calls
  // with the same messages but different response_format produce
  // structurally different responses (JSON object vs free text). Hashing
  // them to the same key would silently replay the wrong fixture.
  const jsonTrue = makeOptions({ json: true });
  const jsonFalse = makeOptions({ json: false });
  assert.notEqual(
    hashRequest(jsonTrue),
    hashRequest(jsonFalse),
    'json must be part of the hash',
  );
});

test('hashRequest differentiates maxTokens values with otherwise-identical requests', () => {
  const short = makeOptions({ maxTokens: 100 });
  const long = makeOptions({ maxTokens: 2000 });
  assert.notEqual(
    hashRequest(short),
    hashRequest(long),
    'maxTokens must be part of the hash',
  );
});

test('hashRequest differentiates reasoning modes', () => {
  const low = makeOptions({ reasoning: 'low' });
  const high = makeOptions({ reasoning: 'high' });
  assert.notEqual(hashRequest(low), hashRequest(high), 'reasoning must be part of the hash');
});

test('hashRequest produces stable keys regardless of property insertion order', () => {
  // Two logically-identical options built with different key orders must
  // hash the same. This is what makes the harness robust against cosmetic
  // caller-side refactors.
  const a: CompletionOptions = {
    model: 'nano',
    messages: [{ role: 'user', content: 'Hi' }],
    json: true,
    maxTokens: 50,
  };
  const b: CompletionOptions = {
    json: true,
    maxTokens: 50,
    messages: [{ role: 'user', content: 'Hi' }],
    model: 'nano',
  };
  assert.equal(hashRequest(a), hashRequest(b));
});

test('hashRequest treats missing reasoning/json/maxTokens as their defaults', () => {
  // `reasoning: undefined` and `reasoning: 'none'` should hash the same
  // because OpenAIProvider treats them identically at the wire. Same for
  // json: undefined vs json: false, maxTokens: undefined vs null.
  const minimal = makeOptions();
  const explicit = makeOptions({ reasoning: 'none', json: false });
  assert.equal(hashRequest(minimal), hashRequest(explicit));
});

test('FixtureLLMProvider dispenses multiple fixtures with the same hash in recorded order', async () => {
  // LLMs are not byte-deterministic for identical requests. The recipe
  // scaler in particular calls with identical inputs multiple times, and
  // the real model can return different responses each time. The queue
  // preserves recording order so replay reproduces the exact sequence.
  const opts = makeOptions();
  const hash = hashRequest(opts);
  const f1: LLMFixture = {
    hash,
    callIndex: 1,
    model: opts.model,
    messages: opts.messages,
    response: 'first response',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const f2: LLMFixture = { ...f1, callIndex: 2, response: 'second response' };
  const f3: LLMFixture = { ...f1, callIndex: 3, response: 'third response' };

  const provider = new FixtureLLMProvider([f1, f2, f3]);

  const r1 = await provider.complete(opts);
  const r2 = await provider.complete(opts);
  const r3 = await provider.complete(opts);
  assert.equal(r1.content, 'first response', 'first call should get first fixture');
  assert.equal(r2.content, 'second response', 'second call should get second fixture');
  assert.equal(r3.content, 'third response', 'third call should get third fixture');

  // Over-dispatch: once the queue is down to its last entry, subsequent
  // calls keep returning the tail rather than throwing. This makes the
  // provider robust to replay sequences that run slightly longer than
  // record (e.g., idempotent retries added after recording).
  const r4 = await provider.complete(opts);
  assert.equal(r4.content, 'third response', 'over-dispatch should replay the last fixture');
});

test('FixtureLLMProvider.transcribe throws a clear "unsupported" error', async () => {
  const provider = new FixtureLLMProvider([]);
  await assert.rejects(
    () => provider.transcribe(Buffer.from([])),
    (err: unknown) => {
      const e = err as Error;
      assert.match(e.message, /pre-transcribe voice events/);
      return true;
    },
  );
});
