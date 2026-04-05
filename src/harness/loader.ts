/**
 * Scenario loader.
 *
 * Two responsibilities:
 *
 *   1. `discoverScenarios(dir)` — find every scenario directory under the
 *      given root. A "scenario directory" is any subdirectory of `dir` that
 *      contains a `spec.ts` file. Returns them sorted alphabetically so
 *      test runs are deterministic.
 *
 *   2. `loadScenario(dir)` — dynamically import the scenario's `spec.ts`,
 *      validate it, read `recorded.json` if present, and return either a
 *      `{ spec, recorded }` pair or a `{ spec, error }` pair where `error`
 *      is a human-readable reason the scenario can't run (no recording,
 *      stale recording, etc.). The runner turns errors into `assert.fail`
 *      calls — the test still counts as "failed", not "crashed mid-run".
 *
 * The loader resolves scenarios relative to the repo root so both the
 * test entry (`test/scenarios.test.ts`) and the generator CLI
 * (`src/harness/generate.ts`) can point at the same directory tree.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashSpec } from './define.js';
import type { RecordedScenario, Scenario } from './types.js';

/**
 * Result of `loadScenario`. Either the recording loaded cleanly, or there's
 * an error message that the caller should surface as a test failure.
 *
 * `error` being set doesn't mean `spec` is absent — the spec is still
 * available for logging, but the recording is missing or stale.
 */
export interface LoadedScenario {
  dir: string;
  spec: Scenario;
  recorded?: RecordedScenario;
  error?: string;
}

/**
 * Walk `rootDir` and return every immediate subdirectory that contains a
 * `spec.ts` file. Sorted alphabetically for deterministic test order.
 *
 * Returns absolute paths.
 */
export async function discoverScenarios(rootDir: string): Promise<string[]> {
  const abs = resolve(rootDir);
  let entries: string[];
  try {
    entries = await readdir(abs);
  } catch {
    return []; // dir doesn't exist — no scenarios
  }

  const dirs: string[] = [];
  for (const name of entries.sort()) {
    const child = join(abs, name);
    const st = await stat(child).catch(() => null);
    if (!st?.isDirectory()) continue;
    const specPath = join(child, 'spec.ts');
    const specStat = await stat(specPath).catch(() => null);
    if (specStat?.isFile()) dirs.push(child);
  }
  return dirs;
}

/**
 * Import the scenario's `spec.ts` and load its `recorded.json` if present.
 *
 * Cases handled:
 *   - Happy path: spec loads, recording exists, hashes match → returns
 *     `{ spec, recorded }`.
 *   - Missing recording: `{ spec, error: "No recording; run npm run ..." }`.
 *   - Stale recording: spec hash doesn't match recorded `specHash` →
 *     `{ spec, error: "Stale recording; spec changed since last generate" }`.
 *   - Malformed spec or JSON → error thrown with enough context to locate
 *     the offending file.
 */
export async function loadScenario(dir: string): Promise<LoadedScenario> {
  const absDir = resolve(dir);
  const specPath = join(absDir, 'spec.ts');
  const recordedPath = join(absDir, 'recorded.json');

  // Dynamic-import the spec. `spec.ts` must export a default Scenario.
  // We use pathToFileURL so ESM imports work on every platform.
  const mod = await import(pathToFileURL(specPath).href);
  const spec: Scenario | undefined = mod.default;
  if (!spec) {
    throw new Error(`Scenario at ${specPath} must export a default Scenario (via defineScenario)`);
  }

  // Attempt to read the recording. Missing file is an expected case, so
  // we check with stat() first — avoids throwing from fs.readFile for a
  // known-benign condition.
  const recordedStat = await stat(recordedPath).catch(() => null);
  if (!recordedStat) {
    return {
      dir: absDir,
      spec,
      error:
        `No recording at ${recordedPath}. ` +
        `Run: npm run test:generate -- ${spec.name}`,
    };
  }

  let recorded: RecordedScenario;
  try {
    const contents = await readFile(recordedPath, 'utf-8');
    recorded = JSON.parse(contents) as RecordedScenario;
  } catch (err) {
    throw new Error(
      `Failed to parse ${recordedPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Stale-recording detection. If the spec changed (new event, different
  // initial state, different recipeSet, different clock), the hash moves
  // and we fail with a specific, actionable error.
  const currentHash = hashSpec(spec);
  if (recorded.specHash !== currentHash) {
    return {
      dir: absDir,
      spec,
      error:
        `Stale recording: spec hash changed since last generate.\n` +
        `  recorded specHash: ${recorded.specHash.slice(0, 12)}…\n` +
        `  current  specHash: ${currentHash.slice(0, 12)}…\n` +
        `Run: npm run test:generate -- ${spec.name} --regenerate`,
    };
  }

  return { dir: absDir, spec, recorded };
}
