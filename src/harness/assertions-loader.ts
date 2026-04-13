/**
 * Loader for scenario-local `assertions.ts` modules.
 *
 * Plan 031 evolves the Plan 017 `fixture-assertions.ts` convention into a
 * single `assertions.ts` per scenario with a richer export surface:
 *
 *   - `purpose: string` — one-sentence load-bearing claim.
 *   - `assertBehavior(ctx)` — deterministic semantic checks over the
 *     scenario outcome. Throws on failure.
 *   - `assertFixtureEdits(recorded)` — optional; only set for fixture-edited
 *     scenarios that hand-edit `llmFixtures` to simulate LLM misbehavior.
 *
 * Absence of `assertions.ts` = legacy scenario (no certification yet); the
 * loader returns `undefined` and the caller skips `assertBehavior` /
 * `assertFixtureEdits` gracefully. If the file exists, `purpose` and
 * `assertBehavior` are REQUIRED; missing either surfaces as a clear error
 * at test time rather than silently skipping checks.
 *
 * `runFixtureEditAssertions(dir, recorded)` is kept as a named export for
 * backward-compat with the `fixture-assertions.ts` call sites (replay.ts,
 * scenarios.test.ts) — it delegates to `loadAssertions` internally and
 * invokes `assertFixtureEdits` only when defined.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RecordedScenario } from './types.js';
import type { AssertionsContext } from './assertions-context.js';

export type AssertBehavior = (ctx: AssertionsContext) => void | Promise<void>;
export type AssertFixtureEdits = (recorded: RecordedScenario) => void | Promise<void>;

/** Back-compat alias retained for the old `FixtureEditAssertion` import. */
export type FixtureEditAssertion = AssertFixtureEdits;

export interface LoadedAssertions {
  path: string;
  purpose?: string;
  assertBehavior?: AssertBehavior;
  assertFixtureEdits?: AssertFixtureEdits;
}

interface AssertionsModule {
  purpose?: unknown;
  assertBehavior?: unknown;
  assertFixtureEdits?: unknown;
}

/**
 * Load `<dir>/assertions.ts` if present. Returns `undefined` when the file
 * is absent (legacy scenarios). Throws with a clear message if the file
 * exists but exports an invalid surface.
 *
 * Validation rules:
 *   - If `assertions.ts` exists, it MUST export both `purpose: string` and
 *     `assertBehavior: (ctx) => void | Promise<void>`.
 *   - `assertFixtureEdits` is optional; if present, it MUST be a function.
 */
export async function loadAssertions(dir: string): Promise<LoadedAssertions | undefined> {
  const assertionsPath = join(dir, 'assertions.ts');
  const assertionsStat = await stat(assertionsPath).catch(() => null);
  if (!assertionsStat?.isFile()) {
    return undefined;
  }

  const mod = (await import(pathToFileURL(assertionsPath).href)) as AssertionsModule;

  if (typeof mod.purpose !== 'string') {
    throw new Error(
      `${assertionsPath} must export \`purpose: string\` describing the ` +
        `scenario's load-bearing claim.`,
    );
  }
  if (typeof mod.assertBehavior !== 'function') {
    throw new Error(
      `${assertionsPath} must export \`assertBehavior(ctx)\` as a function ` +
        `performing deterministic semantic checks over the scenario outcome.`,
    );
  }
  if (mod.assertFixtureEdits !== undefined && typeof mod.assertFixtureEdits !== 'function') {
    throw new Error(
      `${assertionsPath}'s \`assertFixtureEdits\` export must be a function ` +
        `if defined.`,
    );
  }

  return {
    path: assertionsPath,
    purpose: mod.purpose,
    assertBehavior: mod.assertBehavior as AssertBehavior,
    assertFixtureEdits: mod.assertFixtureEdits as AssertFixtureEdits | undefined,
  };
}

/**
 * Backward-compat shim for the old `fixture-assertions.ts` filename.
 *
 * Called by `test/scenarios.test.ts` and `src/harness/replay.ts` before
 * replaying fixtures — ensures that scenarios with hand-edited
 * `llmFixtures` still get their fixture-edit guardrail checked even though
 * the file has been renamed. Silently no-ops when the scenario either has
 * no `assertions.ts` or defines `assertions.ts` without an
 * `assertFixtureEdits` export.
 */
export async function runFixtureEditAssertions(
  dir: string,
  recorded: RecordedScenario,
): Promise<void> {
  const loaded = await loadAssertions(dir);
  if (!loaded?.assertFixtureEdits) {
    return;
  }
  await loaded.assertFixtureEdits(recorded);
}
