/**
 * Fixture-replay LLM provider for scenario tests.
 *
 * Implements `LLMProvider` by looking up pre-recorded responses keyed on a
 * content-hash of the request. Every `complete()` call takes a SHA-256 of
 * the canonicalized request and returns the matching fixture — or throws a
 * diagnostic `MissingFixtureError` with the three closest fixtures by
 * Levenshtein distance on the last user message.
 *
 * ## Why content-hash matching, not call-order
 *
 * Call-order matching is simpler but brittle: any code change that alters
 * the LLM call sequence silently replays the wrong fixtures. Content-hash
 * matches on what the request actually says, so (a) the same request always
 * gets the same response, (b) a different request is a loud failure, and
 * (c) a reordered call sequence with the same underlying calls still works.
 *
 * ## What goes into the hash
 *
 * The hash covers EVERY field that affects the real OpenAI request. Looking
 * at `src/ai/openai.ts:79-80`, the body sent to the API includes `model`,
 * `messages`, `reasoning_effort` (from `reasoning`), `response_format`
 * (from `json`), and `max_completion_tokens` (from `maxTokens`). All five
 * are in the hash.
 *
 * `context` (the cost-tracking label in `CompletionOptions.context`) is
 * deliberately excluded because it never reaches the wire. Two calls with
 * identical OpenAI bodies but different `context` strings would legitimately
 * get the same response; hashing `context` would force unnecessary
 * regeneration.
 *
 * `json` and `maxTokens` are load-bearing in the hash: a call with
 * `{json: true}` and a call with `{json: false}` otherwise-identical
 * produce structurally different responses (JSON object vs free text);
 * colliding them would replay the wrong fixture and silently corrupt the
 * scenario. Same for `maxTokens` — different caps can truncate differently.
 *
 * ## Missing fixture UX
 *
 * When a hash misses, we throw `MissingFixtureError` with:
 *   - the computed hash
 *   - the full request (minus content body) so the agent can eyeball what
 *     changed
 *   - three closest fixtures by Levenshtein on the last user message
 *   - the exact command to regenerate the scenario
 *
 * The agent's loop is: run `npm test`, see the error, decide whether the
 * prompt change is intentional, run `npm run test:generate -- <name>
 * --regenerate`, review the new `recorded.json` via `git diff`, commit.
 */

import { createHash } from 'node:crypto';
import type {
  LLMProvider,
  CompletionOptions,
  CompletionResult,
  ChatMessage,
  ReasoningMode,
} from './provider.js';

// ─── Fixture shape ────────────────────────────────────────────────────────────

/**
 * A single recorded LLM call. Persisted in `recorded.json` under
 * `llmFixtures[]`. The harness builds a `Map<hash, LLMFixture>` at load time
 * and looks up by hash on every `complete()` call.
 *
 * Fields mirror the subset of `CompletionOptions` / `CompletionResult` that
 * matter for replay, plus metadata (`callIndex`) that's purely for humans
 * reading a diff.
 */
export interface LLMFixture {
  /** SHA-256 of the canonicalized request (see `hashRequest`). */
  hash: string;
  /** Ordinal call index at record time — for humans, not used in lookups. */
  callIndex: number;
  /** Model tier — 'primary' | 'mini' | 'nano'. */
  model: CompletionOptions['model'];
  /** Optional reasoning mode — defaults to 'none' when absent. */
  reasoning?: ReasoningMode;
  /** Whether the request asked for a JSON response body. */
  json?: boolean;
  /** Max completion tokens if set on the request. */
  maxTokens?: number;
  /** The full messages array at record time (content-hashed verbatim). */
  messages: ChatMessage[];
  /** The response content returned by the real model. */
  response: string;
  /** Token usage recorded at capture time — replayed for cost accounting. */
  usage: { inputTokens: number; outputTokens: number };
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hash of the request. `JSON.stringify` with a
 * sorted key replacer guarantees that two semantically equivalent request
 * objects hash to the same value regardless of property insertion order.
 *
 * `context` is NOT included (cost label, doesn't affect the wire). Every
 * other field from `CompletionOptions` that reaches the OpenAI API is
 * included — see `src/ai/openai.ts:73-84` for the source of truth.
 */
export function hashRequest(options: CompletionOptions): string {
  const canonical = {
    model: options.model,
    reasoning: options.reasoning ?? 'none',
    json: options.json ?? false,
    maxTokens: options.maxTokens ?? null,
    messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  const serialized = JSON.stringify(canonical, stableReplacer);
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Key-sorting replacer for `JSON.stringify`. For every object, emits keys
 * in alphabetical order so the serialized form is identical regardless of
 * how the caller built the object. Arrays are left as-is (order matters).
 */
function stableReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ─── Error type ───────────────────────────────────────────────────────────────

/**
 * Thrown when a `FixtureLLMProvider` cannot find a matching fixture.
 *
 * The error message is explicitly shaped to be actionable by an agent
 * reading it for the first time: it states the failing hash, the full
 * options minus message bodies (for at-a-glance inspection), the three
 * closest fixtures by Levenshtein on the last user message (usually the
 * only input that changes between runs), and the exact regenerate command.
 */
export class MissingFixtureError extends Error {
  readonly hash: string;
  readonly options: CompletionOptions;
  readonly nearest: { hash: string; distance: number; lastUserMessage: string }[];

  constructor(
    hash: string,
    options: CompletionOptions,
    nearest: { hash: string; distance: number; lastUserMessage: string }[],
  ) {
    const lastUser = lastUserContent(options.messages);
    const summary = [
      `No LLM fixture matched request hash ${hash.slice(0, 12)}…`,
      `  model=${options.model} reasoning=${options.reasoning ?? 'none'} ` +
        `json=${options.json ?? false} maxTokens=${options.maxTokens ?? 'unset'}`,
      `  lastUserMessage=${truncate(lastUser, 160)}`,
      '',
      'Closest recorded fixtures (by Levenshtein on the last user message):',
      ...nearest.map(
        (n, i) =>
          `  ${i + 1}. hash=${n.hash.slice(0, 12)}… distance=${n.distance} ` +
          `lastUser=${truncate(n.lastUserMessage, 120)}`,
      ),
      '',
      'To refresh fixtures for this scenario:',
      '  npm run test:generate -- <scenario-name> --regenerate',
      '',
      'If the prompt change is intentional, review the new recorded.json via git diff before committing.',
    ].join('\n');
    super(summary);
    this.name = 'MissingFixtureError';
    this.hash = hash;
    this.options = options;
    this.nearest = nearest;
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * LLM provider backed entirely by recorded fixtures. Drop-in replacement
 * for `OpenAIProvider` in scenario replay.
 *
 * Construction is cheap — just indexes the fixtures by hash into a `Map`.
 * No network, no API keys, no state to manage. Call `complete()` to look
 * up a response or throw; `transcribe()` is unsupported (voice scenarios
 * pre-transcribe in the spec).
 */
export class FixtureLLMProvider implements LLMProvider {
  /**
   * Per-hash queue of recorded responses. LLMs are not byte-deterministic
   * across identical requests — the recipe scaler is routinely called
   * multiple times with the exact same input (same recipe, same target,
   * same servings → identical prompt → identical hash) and the real
   * model can return slightly different responses each time. If we kept
   * only one response per hash via `Map<hash, fixture>`, the second
   * replay call would get the wrong output and `finalStore` would
   * diverge.
   *
   * The queue preserves recorded order: the first call with hash X gets
   * the first recorded fixture; the second gets the second; and so on.
   * Once a queue is exhausted (a hash was hit more times in replay than
   * it was recorded for) we fall back to the last-seen fixture, so over-
   * dispatch doesn't throw — it just keeps replaying the tail.
   */
  private readonly queueByHash: Map<string, LLMFixture[]>;
  /** Flat read-only list for diagnostic Levenshtein search. */
  private readonly fixtures: readonly LLMFixture[];

  constructor(fixtures: LLMFixture[]) {
    this.fixtures = fixtures;
    // Build the queue in insertion order. The generator writes fixtures
    // to `recorded.json` in the order the calls were made, and
    // `JSON.parse` preserves array order, so iterating here gives us the
    // exact record-time sequence per hash.
    this.queueByHash = new Map();
    for (const f of fixtures) {
      const existing = this.queueByHash.get(f.hash);
      if (existing) {
        existing.push(f);
      } else {
        this.queueByHash.set(f.hash, [f]);
      }
    }
  }

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const hash = hashRequest(options);
    const queue = this.queueByHash.get(hash);
    if (!queue || queue.length === 0) {
      throw new MissingFixtureError(hash, options, this.closestFixtures(options, 3));
    }
    // Dispense the next queued fixture. If the queue has more than one
    // entry, remove the front; if it's the last one, leave it in place
    // so subsequent calls with the same hash still get a response (see
    // queue docstring for rationale).
    const fixture = queue.length > 1 ? queue.shift()! : queue[0]!;
    return {
      content: fixture.response,
      usage: fixture.usage,
    };
  }

  async transcribe(): Promise<string> {
    throw new Error(
      'transcribe() is not supported in fixture mode; pre-transcribe voice events in the scenario spec via `voice(text)`',
    );
  }

  /**
   * Return the `k` recorded fixtures with the smallest Levenshtein distance
   * to the incoming last-user-message. This is the closest-match signal
   * that shows up in `MissingFixtureError` — the agent uses it to eyeball
   * whether a prompt drifted (small distance, similar text) versus a
   * completely new call path (large distance, unrelated text).
   *
   * Only the last user message is compared: it's the field that typically
   * changes between runs, and comparing full message arrays would explode
   * cost for very little signal.
   */
  private closestFixtures(
    options: CompletionOptions,
    k: number,
  ): { hash: string; distance: number; lastUserMessage: string }[] {
    const target = lastUserContent(options.messages);
    const scored = this.fixtures.map((f) => ({
      hash: f.hash,
      distance: levenshtein(target, lastUserContent(f.messages)),
      lastUserMessage: lastUserContent(f.messages),
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, k);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return the content of the last `user` role message, or '' if none. */
function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!.content;
  }
  return '';
}

/** Truncate with an ellipsis marker; preserves newlines as spaces for single-line display. */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

/**
 * Plain Levenshtein edit distance. Cost is `O(a.length * b.length)` which
 * is fine for the short-ish prompts we compare — the alternative is
 * shipping a dependency we only need for error-message niceness.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  // Two-row rolling buffer; we only need the previous row to compute the current.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1, // insertion
        prev[j]! + 1, // deletion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
