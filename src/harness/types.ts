/**
 * Shared types for the scenario harness.
 *
 * Split out from `runner.ts` and `define.ts` so that spec files (which the
 * agent authors by hand) can import type-only declarations without pulling
 * in the runner or capturing-sink implementations.
 *
 * The shape here is deliberately small:
 *   - `Scenario` is what `defineScenario` returns — the input side.
 *   - `RecordedScenario` is what the generator writes to `recorded.json` —
 *     the expected-output side.
 *   - `CapturedKeyboard` and `CapturedOutput` are the comparison-friendly
 *     serializations of grammY keyboards; both sinks emit them verbatim so
 *     `deepStrictEqual` can compare runs against recordings.
 */

import type { PlanSession, Batch, Measurement } from '../models/types.js';
import type { SessionState } from '../state/machine.js';
import type { LLMFixture } from '../ai/fixture.js';

// ─── Event variants ───────────────────────────────────────────────────────────

/**
 * A single input event fed to `BotCore.dispatch`. Mirrors the adapter's
 * `HarnessUpdate` one-for-one so the runner can pass events through without
 * translation; kept as a separate type so spec files don't need to reach
 * into the telegram layer to author scenarios.
 */
export type ScenarioEvent =
  | { type: 'command'; command: string; args?: string }
  | { type: 'text'; text: string }
  | { type: 'callback'; data: string }
  | { type: 'voice'; transcribedText: string };

// ─── Scenario (input side) ────────────────────────────────────────────────────

/**
 * Seed data for the in-memory store at the start of a scenario. Matches
 * `TestStateStoreSeed` exactly; re-declared here so spec authors don't have
 * to import from `harness/test-store.ts` just to type their initial state.
 */
export interface ScenarioInitialState {
  /** Pre-existing session slot. Null = no active session. */
  session?: SessionState | null;
  /** Seed plan sessions for rolling-horizon scenarios. */
  planSessions?: PlanSession[];
  /** Seed batches for rolling-horizon scenarios. */
  batches?: Batch[];
  /** Seed measurements for progress scenarios. */
  measurements?: Measurement[];
}

/**
 * A scenario specification, authored by the agent as a `.ts` file. The
 * spec is THE source of truth for the scenario's inputs; everything else
 * (LLM fixtures, expected outputs, final store state) is derived from
 * running the spec once against the real world via `npm run test:generate`.
 *
 * Fields:
 *   - `name`: must match the directory name under `test/scenarios/`.
 *   - `description`: human-readable summary for diffs and failure messages.
 *   - `clock`: ISO timestamp the harness freezes `Date` at for the entire
 *     scenario. Every `new Date()` call inside the core returns this time.
 *   - `recipeSet`: directory name under `test/fixtures/recipes/` — the
 *     `RecipeDatabase` is constructed from that path.
 *   - `initialState`: `TestStateStore` seed. Empty = fresh user.
 *   - `events`: the exact sequence of updates to feed to `BotCore.dispatch`,
 *     in order. Use the helpers in `define.ts` (`command`, `text`, `click`,
 *     `voice`) for readability.
 */
export interface Scenario {
  name: string;
  description: string;
  clock: string;
  recipeSet: string;
  initialState: ScenarioInitialState;
  events: ScenarioEvent[];
  /**
   * Plan 027: if true, the runner captures a snapshot of `core.session`
   * after every dispatched event and exposes it as `result.sessionAt`.
   * The generator writes the same array to `recorded.expected.sessionAt`.
   * The test file's fourth `deepStrictEqual` asserts them equal if
   * `recorded.expected.sessionAt` is present. Opt-in so scenarios that
   * don't need per-step state assertions don't inflate their recordings.
   */
  captureStepState?: boolean;
}

// ─── Captured outputs (comparison side) ───────────────────────────────────────

/**
 * Serialized form of a grammY `Keyboard` or `InlineKeyboard`. The tagged
 * union preserves the distinction between reply keyboards (persistent bottom
 * menu, buttons send their label as text) and inline keyboards (in-message
 * buttons carrying callback_data) — collapsing them to a flat `string[][]`
 * would let a bug swap one for the other silently.
 */
export type CapturedKeyboard =
  | {
      kind: 'reply';
      buttons: string[][];
      /** `true` if `.persistent()` was called on the underlying Keyboard. */
      persistent?: boolean;
      /** `true` if `.resized()` was called. */
      resized?: boolean;
    }
  | {
      kind: 'inline';
      /** Each button carries its label text and callback_data. */
      buttons: { label: string; callback: string }[][];
    };

/**
 * A single captured `sink.reply(text, { reply_markup })` call. `text` is
 * the clean message body (no debug footer — that lives in the grammY
 * adapter only). `keyboard` is the tagged serialization, or absent if the
 * handler didn't pass one.
 */
export interface CapturedOutput {
  text: string;
  keyboard?: CapturedKeyboard;
}

// ─── Recording (generator output) ─────────────────────────────────────────────

/**
 * The full expectation block the test runner asserts against. Generated
 * once by `npm run test:generate`, committed as part of the scenario, and
 * treated as the golden transcript for all subsequent replays.
 *
 * The test asserts on all three fields independently so a bug producing
 * the right transcript but the wrong persisted plan (or vice versa) still
 * fires — see the "assert on finalStore in addition to outputs" decision
 * in plan 006.
 */
export interface ScenarioExpected {
  outputs: CapturedOutput[];
  /**
   * `BotCore.session` at the end of the scenario. Snapshot-serialized via
   * `JSON.parse(JSON.stringify(core.session))` to guarantee deep equality
   * comparisons work against the recorded form.
   */
  finalSession: unknown;
  /**
   * `testStore.snapshot()` result at the end of the scenario. Same
   * snapshot-serialization contract as `finalSession`.
   */
  finalStore: unknown;
  /**
   * Plan 027: per-step snapshots of `core.session` captured after every
   * dispatched event. Present only when the scenario opts in via
   * `captureStepState: true`. Length equals `spec.events.length` when
   * present.
   */
  sessionAt?: unknown[];
}

/**
 * A recorded scenario — what `recorded.json` deserializes into.
 *
 * `specHash` is a stable hash of the input-defining fields of the scenario
 * (see `hashSpec` in `define.ts`). If the spec changes (new event, different
 * initial state), the hash no longer matches and the runner surfaces a
 * "stale recording" failure prompting the agent to regenerate. This catches
 * the most common drift path without any extra bookkeeping.
 */
export interface RecordedScenario {
  generatedAt: string;
  specHash: string;
  llmFixtures: LLMFixture[];
  expected: ScenarioExpected;
}

// ─── Scenario result (runner output) ──────────────────────────────────────────

/**
 * What `runScenario` returns. The three fields line up with
 * `ScenarioExpected` for a straightforward `deepStrictEqual` comparison in
 * the test body.
 */
export interface ScenarioResult {
  outputs: CapturedOutput[];
  finalSession: unknown;
  finalStore: unknown;
  /**
   * Plan 027: per-step snapshots of `core.session` captured after every
   * dispatched event. Populated only when the scenario opts in via
   * `captureStepState: true`. Length equals `spec.events.length` when
   * populated.
   */
  sessionAt?: unknown[];
}
