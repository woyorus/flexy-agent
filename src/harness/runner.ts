/**
 * Scenario runner.
 *
 * Takes a loaded `Scenario` plus its `RecordedScenario`, wires up the
 * harness dependencies (fixture LLM, test store, recipe DB, frozen clock),
 * drives `BotCore.dispatch` through every event in the spec, and returns a
 * `ScenarioResult` that the test body can `deepStrictEqual` against the
 * recorded expectations.
 *
 * The runner is deliberately thin — it does NO comparison itself; the test
 * file asserts directly on the returned result so that failures surface
 * inside `node:test` with the standard diff output and location info.
 *
 * ## Shared with generate mode
 *
 * `runScenario` is the replay path: it requires a `RecordedScenario` and
 * uses `FixtureLLMProvider`. The generator uses the same wiring internals
 * (clock freeze, `TestStateStore`, `RecipeDatabase`, `BotCore`,
 * `CapturingOutputSink`) but swaps the LLM provider for a recording
 * wrapper around the real `OpenAIProvider`. Both paths share the core
 * loop shape: freeze clock → build deps → dispatch every event → collect
 * result → restore clock. The generator re-implements the loop rather than
 * calling `runScenario` because the LLM wiring differs, but kept
 * structurally identical.
 */

import { join } from 'node:path';
import { copyRecipeSetToTmp } from './recipe-sandbox.js';
import { createBotCore, type BotCoreDeps, type HarnessUpdate } from '../telegram/core.js';
import { RecipeDatabase } from '../recipes/database.js';
import { FixtureLLMProvider } from '../ai/fixture.js';
import { CapturingOutputSink } from './capturing-sink.js';
import { TestStateStore } from './test-store.js';
import { freezeClock } from './clock.js';
import { normalizeUuids } from './normalize.js';
import { HarnessTraceCollector } from './trace.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecordedScenario, Scenario, ScenarioEvent, ScenarioResult } from './types.js';

/**
 * Root directory for recipe fixture libraries. Scenarios reference a set
 * by name; this path is joined with the set name to produce the
 * `RecipeDatabase` root. Resolved relative to `process.cwd()` so `npm test`
 * picks it up regardless of whether it's invoked from the repo root (the
 * typical case) or a subdirectory.
 */
const RECIPE_FIXTURES_ROOT = 'test/fixtures/recipes';

/**
 * Translate a scenario event into a `HarnessUpdate`. They're structurally
 * identical — the two types exist in separate modules to avoid cross-
 * imports between the telegram layer and the harness authoring API. This
 * function is the one place that formally bridges them.
 */
function toUpdate(event: ScenarioEvent): HarnessUpdate {
  switch (event.type) {
    case 'command':
      return event.args !== undefined
        ? { type: 'command', command: event.command, args: event.args }
        : { type: 'command', command: event.command };
    case 'text':
      return { type: 'text', text: event.text };
    case 'callback':
      return { type: 'callback', data: event.data };
    case 'voice':
      return { type: 'voice', transcribedText: event.transcribedText };
  }
}

/**
 * Run a scenario end-to-end under fixture replay.
 *
 * Steps:
 *   1. Freeze `Date` at `spec.clock`.
 *   2. Load the recipe database from `test/fixtures/recipes/<spec.recipeSet>/`.
 *   3. Build a `FixtureLLMProvider` from `recorded.llmFixtures`.
 *   4. Build a `TestStateStore` seeded from `spec.initialState`.
 *   5. Construct a `BotCore` with those deps.
 *   6. Loop through `spec.events`, calling `core.dispatch(event, sink)`
 *      for each — serial, same sink instance throughout so captures land
 *      in order.
 *   7. Return the captured outputs + final session + store snapshot.
 *   8. Restore the clock in a `finally` block so a thrown error can't
 *      leak a patched `Date` to the next scenario.
 *
 * The returned result is intentionally serialized via JSON round-trip so
 * the shape is a match for what `deepStrictEqual` sees on the recorded
 * side (which came from `JSON.parse` of `recorded.json`). Without that,
 * classes like `Map`, `Date`, etc. would hide behind constructor identity
 * and the diff would be confusing.
 */
export async function runScenario(
  spec: Scenario,
  recorded: RecordedScenario,
): Promise<ScenarioResult> {
  return runScenarioWith(spec, () => new FixtureLLMProvider(recorded.llmFixtures));
}

/**
 * Plan 031 Phase 9: run a scenario with a caller-supplied `LLMProvider`
 * factory. Used by the `--live` branch of `npm run review` to swap
 * `FixtureLLMProvider` for a real `OpenAIProvider` without duplicating the
 * wiring (clock freeze, store seeding, core construction, event loop,
 * snapshot). The return type is identical to `runScenario` — callers can
 * pass the result through `buildAssertionsContext` unchanged.
 */
export async function runScenarioWith(
  spec: Scenario,
  llmFactory: () => LLMProvider,
): Promise<ScenarioResult> {
  const clock = freezeClock(spec.clock);
  try {
    // Recipe database loaded from a temp copy so recipe generation
    // during the scenario doesn't pollute the shared fixture set.
    const tmpRecipeDir = await copyRecipeSetToTmp(
      join(RECIPE_FIXTURES_ROOT, spec.recipeSet),
    );
    const recipes = new RecipeDatabase(tmpRecipeDir);
    await recipes.load();

    // Factory-supplied LLM (fixture replay, live, or any other provider).
    const llm = llmFactory();

    // In-memory store seeded from the spec's initial state.
    const store = new TestStateStore({
      session: spec.initialState.session ?? null,
      planSessions: spec.initialState.planSessions,
      batches: spec.initialState.batches,
      measurements: spec.initialState.measurements,
    });

    // Plan 031: attach a trace collector so hooks in BotCore + downstream
    // modules surface as `result.execTrace`. Production (grammY adapter)
    // passes no `onTrace`, so emission is a no-op outside the harness.
    const traceCollector = new HarnessTraceCollector();
    const deps: BotCoreDeps = { llm, recipes, store, onTrace: traceCollector.record };
    const core = createBotCore(deps);
    const sink = new CapturingOutputSink();

    const sessionAt: unknown[] = [];
    for (const event of spec.events) {
      await core.dispatch(toUpdate(event), sink);
      if (spec.captureStepState) {
        // Snapshot-serialize the session after every dispatched event so
        // per-step assertions can verify navigation state transitions.
        // Matches the same JSON+normalizeUuids contract as finalSession.
        sessionAt.push(normalizeUuids(JSON.parse(JSON.stringify(core.session))));
      }
    }

    // Snapshot-serialize both state fields via JSON round-trip, then
    // normalize UUIDs to stable placeholders so the comparison tolerates
    // the non-deterministic ids produced by `uuid.v4()` in plan-flow.
    // Output text may also contain UUIDs (e.g. inside error messages) —
    // normalize the outputs array too for symmetry with the recording.
    const result: ScenarioResult = {
      outputs: normalizeUuids(JSON.parse(JSON.stringify(sink.captured))),
      finalSession: normalizeUuids(JSON.parse(JSON.stringify(core.session))),
      finalStore: normalizeUuids(JSON.parse(JSON.stringify(store.snapshot()))),
      // Plan 031: runtime-only trace; NOT written to recorded.json and NOT
      // compared by `deepStrictEqual`. Surfaced to `assertBehavior(ctx)` via
      // `ctx.execTrace` and to the `npm run review` probe report.
      execTrace: traceCollector.summarize(),
    };
    if (spec.captureStepState) {
      result.sessionAt = sessionAt;
    }
    return result;
  } finally {
    clock.restore();
  }
}

/**
 * Plan 031 Phase 9: run the scenario against the real `OpenAIProvider`.
 *
 * Read-only with respect to disk — the runner never writes `recorded.json`
 * or `certification.json`. Returns a fresh `ScenarioResult` reflecting
 * live LLM behavior so the review CLI can preview whether assertions
 * still hold against current model outputs.
 *
 * Deliberately dynamic-imports `OpenAIProvider` so `runScenario` (the
 * default fixture path) never pulls the real provider into the test
 * process. Only `--live` callers trigger the import.
 */
export async function runScenarioLive(spec: Scenario): Promise<ScenarioResult> {
  const { OpenAIProvider } = await import('../ai/openai.js');
  return runScenarioWith(spec, () => new OpenAIProvider());
}
