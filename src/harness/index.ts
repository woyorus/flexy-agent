/**
 * Harness public API — barrel file.
 *
 * Re-exports the small set of symbols that test files and the generator
 * CLI need. Importing from `src/harness/index.js` (note the `.js`
 * extension under NodeNext) means consumers don't have to know where each
 * type lives inside the harness.
 *
 * Spec files typically only need `defineScenario` and the event helpers
 * from `./define.js`, which they can import directly for clarity. This
 * barrel is for runner-side consumers (`test/scenarios.test.ts`,
 * `src/harness/generate.ts`).
 */

export { defineScenario, hashSpec, command, text, click, voice } from './define.js';
export { runScenario } from './runner.js';
export { discoverScenarios, loadScenario, type LoadedScenario } from './loader.js';
export { CapturingOutputSink } from './capturing-sink.js';
export { TestStateStore } from './test-store.js';
export { freezeClock } from './clock.js';
export type {
  Scenario,
  ScenarioEvent,
  ScenarioInitialState,
  ScenarioResult,
  RecordedScenario,
  ScenarioExpected,
  CapturedOutput,
  CapturedKeyboard,
} from './types.js';
