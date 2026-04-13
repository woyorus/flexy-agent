/**
 * Test entry point — discovers and runs every scenario under
 * `test/scenarios/` plus every unit test under `test/unit/`.
 *
 * Run via `npm test`, which invokes:
 *   tsx --test --import ./test/setup.ts test/scenarios.test.ts
 *
 * `tsx` transpiles TS on the fly, `--test` turns on Node's built-in test
 * runner, and `--import ./test/setup.ts` preloads dummy env vars so
 * `src/config.ts` doesn't throw on module load.
 *
 * ## Why serial, not parallel
 *
 * The harness's `freezeClock` utility (`src/harness/clock.ts`) mutates
 * `globalThis.Date` process-wide. Two scenarios running concurrently
 * would clobber each other's clocks — one scenario would see the other's
 * frozen time, date-dependent prompts would hash wrong, and fixtures
 * would miss or match the wrong call. The for-loop below registers each
 * scenario as its own `test(...)`, but because `node:test` runs tests
 * declared in a single file serially by default, they execute in order.
 *
 * See the "serial execution" decision in plan 006 for the path to
 * parallelism (eliminate process-global state via AsyncLocalStorage or
 * worker sandboxing) if it ever becomes a bottleneck.
 *
 * ## Why asserting on all three: outputs, finalSession, finalStore
 *
 * A bug that produces a correct transcript but skips `store.savePlan()`
 * would pass a transcript-only check while silently breaking the user's
 * persisted plan. Conversely, a bug that persists correctly but sends
 * the wrong message would pass a store-only check. The harness exists
 * precisely to catch this class of silent failure, so every scenario
 * checks all three.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  discoverScenarios,
  loadScenario,
  runScenario,
  runFixtureEditAssertions,
  runGlobalInvariants,
  loadAssertions,
  buildAssertionsContext,
} from '../src/harness/index.js';
// `runFixtureEditAssertions` now lives in `assertions-loader.ts` (see Plan
// 031 Phase 1). The barrel re-export keeps this import stable; the symbol's
// implementation delegates to `loadAssertions` under the hood. Plan 031
// Phase 5 also wires `loadAssertions` + `buildAssertionsContext` here so
// scenarios that define `assertBehavior(ctx)` run their semantic checks
// inside the scenario test body.

// ─── Unit tests ───────────────────────────────────────────────────────────────
// Import every `*.test.ts` file under `test/unit/` so `tsx --test` picks up
// their `test(...)` declarations alongside the scenarios. The dynamic import
// pattern keeps this file ignorant of the unit tests' existence — drop a
// file into `test/unit/` and it's discovered on the next run.
const unitDir = new URL('./unit/', import.meta.url);
try {
  const entries = await readdir(unitDir);
  for (const name of entries.sort()) {
    if (!name.endsWith('.test.ts')) continue;
    await import(new URL(name, unitDir).href);
  }
} catch {
  // No unit tests yet — fine.
}

// ─── Scenario replay ──────────────────────────────────────────────────────────
const scenarioRoot = new URL('./scenarios/', import.meta.url).pathname;

const scenarioDirs = await discoverScenarios(scenarioRoot);

for (const dir of scenarioDirs) {
  // Load synchronously-enough (top-level await) so we can register a test
  // with a known name. Any import-time spec error surfaces here as a test
  // failure against the directory name.
  let loaded: Awaited<ReturnType<typeof loadScenario>>;
  try {
    loaded = await loadScenario(dir);
  } catch (err) {
    const name = dir.split('/').pop() ?? dir;
    test(`scenario: ${name}`, () => {
      assert.fail(`Failed to load ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    });
    continue;
  }

  const { dir: loadedDir, spec, recorded, error } = loaded;
  test(`scenario: ${spec.name}`, async () => {
    if (error) {
      assert.fail(error);
    }
    if (!recorded) {
      assert.fail(`Scenario ${spec.name}: no recorded expectations and no error surfaced`);
    }
    await runFixtureEditAssertions(loadedDir, recorded);
    const result = await runScenario(spec, recorded);

    // Global invariants (Plan 031) — six checks that MUST hold for every
    // scenario. Run BEFORE the `deepStrictEqual` trio so that a semantic
    // failure (e.g. fallback error message leaked into transcript) surfaces
    // ahead of raw byte diffs. The aggregate message includes every
    // failing invariant so the agent can fix them in a single pass.
    const invariantResults = runGlobalInvariants(recorded, result.outputs);
    const failedInvariants = invariantResults.filter((r) => !r.passed);
    if (failedInvariants.length > 0) {
      assert.fail(
        `global invariants failed:\n` +
          failedInvariants.map((r) => `  [${r.id}] ${r.message ?? ''}`).join('\n'),
      );
    }

    // Plan 031 Phase 5: scenario-local `assertBehavior(ctx)` — semantic
    // checks authored alongside the scenario itself. Runs AFTER global
    // invariants so the suite-wide "every scenario must X" checks fire
    // first, and BEFORE the `deepStrictEqual` trio so behavioral failures
    // surface ahead of byte-diff noise. Legacy scenarios without
    // `assertions.ts` skip this step silently.
    const loadedAssertions = await loadAssertions(loadedDir);
    if (loadedAssertions?.assertBehavior) {
      const ctx = buildAssertionsContext({
        spec,
        outputs: result.outputs,
        finalSession: result.finalSession,
        finalStore: result.finalStore,
        sessionAt: result.sessionAt,
        // The runner always populates `execTrace` under Plan 031 Phase 3.
        execTrace: result.execTrace!,
      });
      await loadedAssertions.assertBehavior(ctx);
    }

    // Three independent assertions so the failure report pinpoints WHICH
    // aspect diverged — transcript, session state, or persistence.
    assert.deepStrictEqual(
      result.outputs,
      recorded.expected.outputs,
      'outputs diverged from recorded transcript',
    );
    assert.deepStrictEqual(
      result.finalSession,
      recorded.expected.finalSession,
      'finalSession diverged from recorded state',
    );
    assert.deepStrictEqual(
      result.finalStore,
      recorded.expected.finalStore,
      'finalStore diverged from recorded state',
    );
    // Plan 027: per-step session assertions for scenarios that opt in.
    // The recording's `sessionAt` is undefined for scenarios without
    // `captureStepState: true`, and the check below is then skipped — so
    // existing scenarios are unaffected.
    if (recorded.expected.sessionAt !== undefined) {
      assert.deepStrictEqual(
        result.sessionAt,
        recorded.expected.sessionAt,
        'sessionAt diverged from recorded per-step state',
      );
    }
  });
}
