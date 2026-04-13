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
export {
  loadAssertions,
  runFixtureEditAssertions,
  type AssertBehavior,
  type AssertFixtureEdits,
  type FixtureEditAssertion,
  type LoadedAssertions,
} from './assertions-loader.js';
export { buildAssertionsContext, type AssertionsContext } from './assertions-context.js';
export {
  HarnessTraceCollector,
  type ExecTrace,
  type TraceEvent,
} from './trace.js';
export { runGlobalInvariants, type InvariantResult } from './invariants.js';
export {
  assertPlanningHealthy,
  assertSlotCoverage,
  assertNoGhostBatches,
  assertNoOrphanSlots,
  assertNoDoubleBooking,
  assertBatchSizesSane,
  assertCookDayFirstEating,
  assertWeeklyTotalsAbsorbed,
  assertRollingCarryOver,
  assertNoBatchOverlapsPriorSession,
  assertSaveBeforeDestroy,
  assertDispatcherActions,
  assertMutationHistoryLength,
  assertNoDispatcherCallFor,
  assertMeasurementPersisted,
  assertWeeklyReportShape,
  assertLastRenderedView,
  assertSessionAtVariants,
  renderDerivedPlanView,
} from './domain-helpers.js';
export {
  hashFile,
  currentHashes,
  loadStamp,
  writeStamp,
  deriveStatus,
  type CertificationStamp,
  type CertificationStatus,
  type CertificationStoredStatus,
  type CurrentHashes,
} from './certification.js';
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
