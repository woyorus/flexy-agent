/**
 * Scenario fixture replayer.
 *
 * A standalone CLI that replays a scenario using the existing `llmFixtures`
 * in `recorded.json` (no real LLM calls) and overwrites only the `expected`
 * section with the fresh outputs, session, and store snapshot.
 *
 * ## When to use
 *
 * After manually editing `llmFixtures` in `recorded.json` (e.g., for
 * scenarios with `fixture-edits.md` that simulate LLM misbehavior).
 * `--regenerate` would destroy those edits by calling the real LLM.
 * This script preserves the edited fixtures and re-records what the code
 * actually produces with them.
 *
 * ## Invocation
 *
 *   npm run test:replay -- <scenario-name>
 *
 * Exit 0 on success; exit 1 on any error.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScenario } from './runner.js';
import { hashSpec } from './define.js';
import { runFixtureEditAssertions } from './assertions-loader.js';
import type { Scenario, RecordedScenario } from './types.js';

const SCENARIOS_ROOT = 'test/scenarios';

function parseArgs(argv: string[]): string {
  const args = argv.slice(2);
  const scenarioName = args.find((a) => !a.startsWith('--'));
  if (!scenarioName) {
    throw new Error('Missing scenario name.\nUsage: npm run test:replay -- <scenario-name>');
  }
  return scenarioName;
}

async function loadSpec(dir: string): Promise<Scenario> {
  const specPath = join(dir, 'spec.ts');
  const mod = await import(pathToFileURL(specPath).href);
  const spec: Scenario | undefined = mod.default;
  if (!spec) {
    throw new Error(`${specPath} must export a default Scenario via defineScenario`);
  }
  return spec;
}

async function main(): Promise<void> {
  const scenarioName = parseArgs(process.argv);
  const dir = resolve(SCENARIOS_ROOT, scenarioName);
  const recordedPath = join(dir, 'recorded.json');

  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`Scenario directory not found: ${dir}`);
  }

  const recordedStat = await stat(recordedPath).catch(() => null);
  if (!recordedStat) {
    throw new Error(
      `No recorded.json found at ${recordedPath}.\n` +
        'Run `npm run test:generate` first to create the initial recording.',
    );
  }

  const spec = await loadSpec(dir);
  const recorded: RecordedScenario = JSON.parse(await readFile(recordedPath, 'utf-8'));

  console.log(`Replaying: ${spec.name}`);
  console.log(`  ${spec.description}`);
  console.log(`  clock: ${spec.clock}`);
  console.log(`  llmFixtures: ${recorded.llmFixtures.length}`);

  await runFixtureEditAssertions(dir, recorded);

  // Run the scenario using the existing (potentially edited) fixtures.
  const result = await runScenario(spec, recorded);

  // Overwrite only the expected section — preserve llmFixtures as-is.
  const updated: RecordedScenario = {
    generatedAt: new Date().toISOString(),
    specHash: hashSpec(spec),
    llmFixtures: recorded.llmFixtures,
    expected: {
      outputs: result.outputs,
      finalSession: result.finalSession,
      finalStore: result.finalStore,
    },
  };

  await writeFile(recordedPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');

  console.log('\n✓ Expected outputs re-recorded from existing fixtures (no LLM calls).');
  console.log(`  path: ${recordedPath}`);
  console.log(`  outputs: ${result.outputs.length}`);
  console.log('\nNext: review expected outputs via `git diff`, then `npm test` to confirm.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
