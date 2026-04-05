/**
 * Scenario authoring API.
 *
 * A tiny typed surface that spec files use to declare scenarios. The goal
 * is that an agent reading a spec for the first time understands it
 * without loading any other harness file — the helpers are obvious
 * one-liners, `defineScenario` is a typed identity function, and the
 * types live in `./types.ts` alongside.
 *
 * ## What this module does NOT do
 *
 * Validation is minimal on purpose:
 *
 *   - `defineScenario` checks that `events` is non-empty and `clock` parses
 *     as a valid ISO timestamp. That's it.
 *   - It does NOT validate that a `click('...')` callback string matches a
 *     real handler in the bot. The bot's callback space uses prefix
 *     matching for parameterized callbacks (`rv_<slug>`, `rd_<slug>`,
 *     `re_<slug>`, `rp_<page>`, `plan_gen_gap_<index>`, etc. — see
 *     `src/telegram/core.ts` dispatch logic). A literal-registry check
 *     would reject valid dynamic callbacks; a smarter check would
 *     duplicate the dispatch logic and drift as the bot evolves. Typos
 *     surface instead at replay time via the transcript diff, which is
 *     strictly more accurate than a parallel validation layer.
 *   - It does NOT validate that `recipeSet` exists on disk. The runner
 *     does that at load time when constructing the `RecipeDatabase` — a
 *     missing directory fails there with a clear path. Doing it twice
 *     would be noise.
 *
 * ## What `hashSpec` is for
 *
 * `hashSpec` takes a scenario and produces a stable SHA-256 over the
 * input-defining fields (`events`, `initialState`, `recipeSet`, `clock`).
 * The generator writes this hash into `recorded.json`; the runner
 * re-computes it on load and fails loudly if the hashes diverge, which
 * means the spec changed but the recording wasn't regenerated. The
 * description field is NOT hashed — it's human annotation, not behavior.
 */

import { createHash } from 'node:crypto';
import type { Scenario, ScenarioEvent } from './types.js';

// ─── defineScenario ───────────────────────────────────────────────────────────

/**
 * Accept a scenario spec and return it untouched after minimal validation.
 * Typed as an identity function so the return value preserves literal
 * types for use at call sites (e.g., `test(spec.name, ...)` narrows
 * correctly).
 *
 * Validation failures throw at spec import time so the test runner surfaces
 * them with the file path in the stack trace — easy to fix, hard to ignore.
 */
export function defineScenario(spec: Scenario): Scenario {
  if (!spec.name || spec.name.trim().length === 0) {
    throw new Error('Scenario.name must be a non-empty string');
  }
  if (!spec.description || spec.description.trim().length === 0) {
    throw new Error(`Scenario ${spec.name}: description is required`);
  }
  if (!spec.recipeSet || spec.recipeSet.trim().length === 0) {
    throw new Error(`Scenario ${spec.name}: recipeSet is required`);
  }
  if (!spec.clock) {
    throw new Error(`Scenario ${spec.name}: clock is required`);
  }
  const parsed = Date.parse(spec.clock);
  if (Number.isNaN(parsed)) {
    throw new Error(`Scenario ${spec.name}: clock "${spec.clock}" is not a valid ISO timestamp`);
  }
  if (!Array.isArray(spec.events) || spec.events.length === 0) {
    throw new Error(`Scenario ${spec.name}: events must be a non-empty array`);
  }
  return spec;
}

// ─── Event helpers ────────────────────────────────────────────────────────────

/**
 * Telegram `/command` event (e.g. `/start`, `/cancel`). Optionally carries
 * space-separated args — this mirrors what grammY gives us in prod.
 */
export function command(name: string, args?: string): ScenarioEvent {
  return args !== undefined ? { type: 'command', command: name, args } : { type: 'command', command: name };
}

/**
 * Free-form text message OR a reply-keyboard button tap. The main menu is
 * a reply keyboard, so tapping "📋 Plan Week" arrives as plain text with
 * that exact label. Use `text('📋 Plan Week')` for reply-keyboard buttons;
 * use `click('...')` for inline buttons.
 */
export function text(content: string): ScenarioEvent {
  return { type: 'text', text: content };
}

/**
 * Inline-keyboard button tap. `data` is the callback_data string the
 * button was registered with (e.g., `'plan_keep_breakfast'`, `'rv_chicken-rice-bowl'`).
 * No authoring-time validation — see module-level comment.
 */
export function click(data: string): ScenarioEvent {
  return { type: 'callback', data };
}

/**
 * Voice message. The real Telegram adapter transcribes via Whisper before
 * dispatching; scenarios skip audio entirely and provide the transcribed
 * text directly, which is routed through the same code path.
 */
export function voice(transcribedText: string): ScenarioEvent {
  return { type: 'voice', transcribedText };
}

// ─── Spec hash ────────────────────────────────────────────────────────────────

/**
 * Stable SHA-256 hash of the input-defining fields of a scenario. Used by
 * the generator to stamp `recorded.json` and by the runner to detect stale
 * recordings (spec changed, recording wasn't regenerated).
 *
 * Fields included: `events`, `initialState`, `recipeSet`, `clock`.
 * Excluded: `name` (cosmetic), `description` (annotation).
 *
 * Uses a key-sorting JSON replacer so two logically-identical specs
 * constructed in different property orders hash the same — same trick as
 * `FixtureLLMProvider.hashRequest`.
 */
export function hashSpec(spec: Scenario): string {
  const canonical = {
    clock: spec.clock,
    events: spec.events,
    initialState: spec.initialState ?? {},
    recipeSet: spec.recipeSet,
  };
  const serialized = JSON.stringify(canonical, stableReplacer);
  return createHash('sha256').update(serialized).digest('hex');
}

/** Alphabetical-key replacer for stable JSON serialization. */
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
