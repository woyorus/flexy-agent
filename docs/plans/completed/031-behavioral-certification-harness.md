# Plan 031: Behavioral Certification Harness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Complete (2026-04-13)
**Date:** 2026-04-13
**Affects:** `src/harness/` (new: `invariants.ts`, `domain-helpers.ts`, `assertions-context.ts`, `certification.ts`, `review.ts`, `trace.ts`; modified: `runner.ts`, `types.ts`, `index.ts`, `fixture-assertions.ts` → `assertions-loader.ts`, `generate.ts`, `replay.ts`), `src/telegram/core.ts` and `src/telegram/dispatcher-runner.ts` (thin `onTrace` hook points at dispatch entry, dispatcher decision, and `store.logMeasurement` writes), `src/agents/plan-flow.ts` and `src/plan/mutate-plan-applier.ts` (`onTrace` threaded through; `persist` events at `confirmPlanSession*` writes), `src/agents/plan-proposer.ts`, `src/agents/plan-reproposer.ts`, `src/agents/recipe-flow.ts` (one `retry` emission each at the inline validator-retry site), `test/scenarios.test.ts` (call global invariants + `assertBehavior`), `test/scenarios/014-proposer-orphan-fill/` (migrate `fixture-assertions.ts` → `assertions.ts`; add `certification.json`), `package.json` (add `review` script), `docs/product-specs/testing.md`, `docs/design-docs/004-behavioral-certification-harness.md` (status note), `CLAUDE.md` (debug-workflow references to `review`).

---

## Goal

Evolve the replay-determinism harness into a **behavioral certification harness**. Add scenario-local `assertions.ts` modules exporting `purpose` + `assertBehavior(ctx)` (and optionally `assertFixtureEdits(recorded)`), runner-enforced global invariants, a reusable domain helper library, a runtime-only execution trace, a per-scenario `certification.json` stamp, and an `npm run review` CLI that lists certification status at suite level, renders per-scenario probe reports, runs `--live` against the real LLM read-only, and `--accept`s current on-disk state into the stamp. `deepStrictEqual` stays as the regression net. `recorded.json` gains no new locked fields.

## Architecture

Five layers stacked on top of the existing replay harness (Plan 006 + 017 + 027):

1. **Behavioral assertion layer.** A scenario's `assertions.ts` exports a `purpose` string and an `assertBehavior(ctx)` function that receives an `AssertionsContext` carrying `spec`, `outputs`, `finalSession`, `finalStore`, `sessionAt?`, `execTrace`, and access to domain-helper utilities. New scenarios MUST include `assertions.ts` to be certifiable; legacy scenarios may omit it until audit cycle one visits them. The module is the same file-slot as today's `fixture-assertions.ts` — it just gains two required exports (`purpose`, `assertBehavior`) on top of the existing optional `assertFixtureEdits`.

2. **Global invariant enforcement.** A small fixed set of invariants in `src/harness/invariants.ts` runs on every scenario during `npm test`. These are truly global (recording well-formed, no "Something went wrong" fallback in any output text, no `undefined` / `[object Object]` substrings, empty keyboards illegal, no raw UUIDs in the recorded expectations). Not configurable per scenario; scenario-specific checks live in `assertBehavior`.

3. **Runtime-only execution trace.** `BotCoreDeps` gains an optional `onTrace?: (event: TraceEvent) => void` callback. A small number of hook points emit structured events: each handler entry, each dispatcher decision, each validator retry (at the three inline retry sites in `plan-proposer.ts` / `plan-reproposer.ts` / `recipe-flow.ts`; `qaGate` itself is unused today and not instrumented), each `store.*` mutation. The harness runner wires a `HarnessTraceCollector` that accumulates events and surfaces them as `result.execTrace`. Production `grammY` adapter does not pass `onTrace`, so emission is a no-op. `execTrace` is **not** persisted to `recorded.json` and **not** compared by `deepStrictEqual` — it is available only to `assertBehavior` via `ctx.execTrace` and to the review report.

4. **Certification stamp.** A per-scenario `certification.json` lives next to `recorded.json`. Holds `reviewedAt`, `specHash`, `assertionsHash`, `recordingHash`, and `status: certified | obsolete`. Absence of file = `uncertified` (derived). Stored `certified` + hash drift = `needs-review` (derived). Stored `obsolete` = `obsolete` sticky (drift does not resurrect). Whether the scenario is fixture-edited is derived from the presence of an `assertFixtureEdits` export on the assertions module, not stored in the stamp.

5. **Review CLI.** `npm run review` without args lists every scenario with its derived certification status and supports `--needs-review` / `--status` filters. `npm run review <scenario>` runs the scenario in replay mode and renders a probe report (purpose, transcript, derived plan view for planning scenarios, global-invariant results, `assertBehavior` result, execution trace summary, current certification status). `--live` swaps the fixture LLM for the real `OpenAIProvider` — read-only with respect to disk. `--accept` hashes the current on-disk spec/assertions/recording and writes the stamp with `status: certified`. `--live` and `--accept` do not combine.

## Tech stack

TypeScript, Node 22+, the existing scenario harness (`src/harness/runner.ts`, `src/telegram/core.ts`, `node:test`), `src/ai/openai.ts` for `--live`, `crypto.createHash` for stamps. No new runtime dependencies, no database changes, no changes to the grammY adapter beyond NOT passing the optional `onTrace`.

## Scope

**In scope:**

- All nine design decisions in `docs/design-docs/004-behavioral-certification-harness.md`.
- Migration of scenario 014 (`proposer-orphan-fill`) from `fixture-assertions.ts` to `assertions.ts`, plus its first `certification.json`.
- Documentation updates in `docs/product-specs/testing.md` and `CLAUDE.md`.
- Design doc 004 status note: add "Shipped in Plan 031" annotation.

**Out of scope (explicitly deferred):**

- **Audit cycle one.** Adding `assertions.ts` to the remaining ~60 legacy scenarios. Handled by a separate plan (032+) that goes scenario-by-scenario. Those scenarios remain `uncertified` in the review list but continue to pass `npm test` via replay + global invariants.
- **Generalizing the QA-gate-and-retry pattern** across all LLM call sites (dispatcher, recipe generator, re-proposer, etc.). Named in the design doc § "Fixture-edited scenarios" as separate work.
- **Ship gate requiring 100% certified coverage.** Enabled by this plan but not designed here.
- **LLM-as-judge certification.** Design decision 9 is explicit: assertions are deterministic code. No runtime LLM grading.
- **Sequencing of audit cycle one** (how many scenarios per session, which classes first).

## Dependencies

- **Plan 006** (test-harness-and-scenario-replay) — provides `BotCore`, `FixtureLLMProvider`, `TestStateStore`, `CapturingOutputSink`, `freezeClock`, the runner + generate + replay CLIs.
- **Plan 017** (fixture-edited-scenario-guardrails) — provides the `fixture-assertions.ts` convention. Plan 031 subsumes and replaces the filename with `assertions.ts`, keeping the `assertFixtureEdits` function as an optional export.
- **Plan 024** (flexible-batch-model) — scenario 014 is the canonical fixture-edited scenario; its assertions are the reference implementation for the migration in Phase 5.
- **Plan 027** (navigation-state-model) — the `captureStepState: true` opt-in and `sessionAt` field are surfaced in `AssertionsContext` as `ctx.sessionAt`.
- **Plan 028** (dispatcher-infrastructure) — the dispatcher decision is one of four `TraceEvent` kinds; hooks attach at `runDispatcherFrontDoor`.

No direct production code dependencies on other in-progress work.

---

## Problem

(See `docs/design-docs/004-behavioral-certification-harness.md` § "Problem" for the full framing.)

Summary: `npm test` currently proves replay-determinism, not behavioral correctness. Recordings locked in before the 5-step verification protocol was strict may encode wrong behavior. Scenario-specific intent lives in `description` strings and the agent's head — nothing in the suite says "scenario 045 passes iff the salmon batch is dropped and `confirmPlanSessionReplacing` fires." Under time pressure a regeneration can slip through without behavioral review. There is no mechanism to distinguish "baseline is behaviorally certified" from "baseline replays byte-equal." A green suite is necessary but not sufficient evidence of correctness.

---

## Plan of work

### File structure

**Files to create:**

- `src/harness/assertions-context.ts` — The `AssertionsContext` interface and factory. `ctx` carries `spec` (the Scenario), `outputs` (captured transcript), `finalSession`, `finalStore`, `sessionAt?` (per-step snapshots when `captureStepState: true`), `execTrace` (runtime trace summary), and a namespace of readonly helpers (`ctx.activeSession`, `ctx.batches`, `ctx.flexSlots`, `ctx.replyContaining`, `ctx.lastOutput`). Helpers are computed on demand from `finalStore` + `outputs`, not stored.

- `src/harness/assertions-loader.ts` — Evolution of today's `src/harness/fixture-assertions.ts`. Loads a scenario's `assertions.ts` (if present) and surfaces four things: `purpose: string | undefined`, `assertBehavior: (ctx) => void | Promise<void> | undefined`, `assertFixtureEdits: (recorded) => void | Promise<void> | undefined`, and `modulePath: string | undefined`. Throws a clear error if the file exists but doesn't export `purpose` + `assertBehavior` (ignoring the fixture-edited case where `assertFixtureEdits` alone is valid but `purpose` + `assertBehavior` still required — per design decision 7). The existing `src/harness/fixture-assertions.ts` module is renamed to `assertions-loader.ts`; the old filename is no longer exported.

- `src/harness/invariants.ts` — A small fixed set of global invariant checks. Exports `runGlobalInvariants(recorded, outputs): InvariantResult[]`. Each invariant is a pure function over recorded + outputs. Invariants:
  - **GI-01 recording-well-formed**: `recorded.generatedAt` parses as ISO, `recorded.specHash` is 64-char hex, `recorded.llmFixtures` is an array, `recorded.expected.outputs` is an array, `recorded.expected.finalSession` is present.
  - **GI-02 no-fallback-messages**: no `output.text` matches `/Something went wrong/i`.
  - **GI-03 no-undefined-or-stringified-objects**: no `output.text` contains `undefined` or `[object Object]`.
  - **GI-04 no-empty-replies**: every `output.text` is non-empty after trim.
  - **GI-05 keyboards-non-empty**: every present `output.keyboard` has ≥ 1 row and every row has ≥ 1 button.
  - **GI-06 uuids-normalized**: `JSON.stringify(recorded.expected)` contains no raw UUID (regex `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`).
  
  Returns `InvariantResult[]` where each element is `{ id, passed, message? }`. The runner collects all results per scenario and fails `npm test` if any are not `passed`.

- `src/harness/domain-helpers.ts` — Reusable domain-assertion helpers. Exports `assertPlanningHealthy(ctx)` as the top-level composed helper, plus the primitives it composes: `assertSlotCoverage(ctx)`, `assertNoGhostBatches(ctx)`, `assertNoOrphanSlots(ctx)`, `assertNoDoubleBooking(ctx)`, `assertBatchSizesSane(ctx)`, `assertCookDayFirstEating(ctx)`, `assertWeeklyTotalsAbsorbed(ctx)`. Each primitive walks `ctx.finalStore` / `ctx.finalSession` / `ctx.outputs` and throws with a specific actionable message on failure. The bodies mirror (and replace) the manual checks in `docs/product-specs/testing.md` § "Verifying recorded output" steps 2 and 3 and the `node -e "..."` quick-verification script in the same section.

- `src/harness/trace.ts` — `TraceEvent` tagged union and `HarnessTraceCollector` class.
  ```typescript
  export type TraceEvent =
    | { kind: 'handler'; name: string }
    | { kind: 'dispatcher'; action: string; params?: unknown }
    | { kind: 'retry'; validator: string; attempt: number; errors: string[] }
    | { kind: 'persist'; op: string; argSummary?: string };
  
  export interface ExecTrace {
    readonly handlers: readonly string[];
    readonly dispatcherActions: readonly { action: string; params?: unknown }[];
    readonly validatorRetries: readonly { validator: string; attempt: number; errors: string[] }[];
    readonly persistenceOps: readonly { op: string; argSummary?: string }[];
  }
  
  export class HarnessTraceCollector {
    private events: TraceEvent[] = [];
    record = (event: TraceEvent): void => { this.events.push(event); };
    summarize(): ExecTrace { /* group events by kind */ }
  }
  ```

- `src/harness/certification.ts` — Certification stamp format + load/save/derive. Exports `CertificationStamp`, `CertificationStatus = 'certified' | 'needs-review' | 'uncertified' | 'obsolete'`, `hashFile(path)`, `loadStamp(dir)`, `writeStamp(dir, stamp)`, `deriveStatus(stamp, currentHashes): CertificationStatus`. Stamp shape:
  ```json
  {
    "reviewedAt": "2026-04-13T12:34:56Z",
    "specHash":        "sha256:...",
    "assertionsHash":  "sha256:...",
    "recordingHash":   "sha256:...",
    "status": "certified"
  }
  ```
  Hashes are sha256 over the raw file bytes (working-tree, not git HEAD). Status derivation: absent file → `uncertified`. Stored `obsolete` → `obsolete` (sticky, wins regardless of drift). Stored `certified` + all three hashes match → `certified`. Stored `certified` + any hash differs → `needs-review`.

- `src/harness/review.ts` — New CLI entry point, similar shape to `src/harness/generate.ts` and `src/harness/replay.ts`. Parses args, routes to suite-level listing (`listAllScenarios`) or scenario-level probe (`probeScenario`), supports `--live` (swap LLM to real), `--accept` (write stamp), `--status`, `--needs-review`. Re-uses the runner's wiring internals.

- `test/unit/invariants.test.ts` — Unit coverage for each of GI-01..GI-06. Positive and negative cases per invariant.

- `test/unit/domain-helpers.test.ts` — Unit coverage for `assertPlanningHealthy` composition and each primitive. Uses hand-built small ctx objects.

- `test/unit/certification.test.ts` — Unit coverage for `deriveStatus` matrix (absent file; stored certified + match; stored certified + drift; stored obsolete + drift; stored obsolete + match).

- `test/unit/trace.test.ts` — Unit coverage for `HarnessTraceCollector.summarize()`.

- `test/scenarios/014-proposer-orphan-fill/assertions.ts` — Replaces `fixture-assertions.ts`. Exports `purpose`, `assertBehavior`, `assertFixtureEdits`. See Phase 5.

- `test/scenarios/014-proposer-orphan-fill/certification.json` — First stamped scenario. Hand-authored initially; regenerated via `npm run review -- 014-proposer-orphan-fill --accept` at the end of Phase 5 to prove the `--accept` path produces identical output.

**Files to modify:**

- `src/harness/types.ts`:
  - Add `execTrace?: ExecTrace` to `ScenarioResult` (runtime-only; NOT added to `ScenarioExpected` — never persisted).
  - Re-export `ExecTrace`, `TraceEvent` from `./trace.js`.
  - Re-export `AssertionsContext` from `./assertions-context.js`.
  - Re-export `CertificationStamp`, `CertificationStatus` from `./certification.js`.

- `src/harness/index.ts`:
  - Add barrel exports for all new modules (`assertions-context`, `assertions-loader`, `invariants`, `domain-helpers`, `trace`, `certification`).
  - Keep `runFixtureEditAssertions` exported from `assertions-loader.ts` (backward-compat name for the old `fixture-assertions.ts` export).

- `src/harness/runner.ts`:
  - Construct a `HarnessTraceCollector` per scenario.
  - Pass `collector.record` as `deps.onTrace` to `createBotCore`.
  - Populate `result.execTrace = collector.summarize()`.
  - The `execTrace` field is ephemeral — it's not JSON-stringified into the comparison path. Assertions read it via `ctx.execTrace`.

- `src/harness/generate.ts`:
  - No-op for trace (fixture generation doesn't surface trace).
  - On scenarios with an `assertions.ts`, print a reminder in the post-generate output: "This scenario has assertions.ts. Run `npm run review -- <name>` to verify behavior before committing."
  - Existing `fixture-edits.md` warning path unchanged.

- `src/harness/replay.ts`:
  - Unchanged functionally. Continue calling `runFixtureEditAssertions(dir, recorded)` (which now lives in `assertions-loader.ts`).

- `src/telegram/core.ts`:
  - Extend `BotCoreDeps` with `onTrace?: (event: TraceEvent) => void`.
  - Emit `{ kind: 'handler', name: 'dispatch:command' }` / `:callback` / `:text` / `:voice` at `dispatch` entry.
  - Emit `{ kind: 'handler', name: '<handler-name>' }` inside each top-level callback `case` in `handleCallback`, and before each main-menu action in `handleMenu`.
  - Emit `{ kind: 'persist', op: 'logMeasurement' }` before the call at `src/telegram/core.ts:791`. (This file's only mutation call site.) The full table of cross-file mutation sites is in Step 3.5.

- `src/telegram/dispatcher-runner.ts`:
  - Accept `onTrace` through `DispatcherRunnerDeps` (or through the existing `deps` bundle).
  - Emit `{ kind: 'dispatcher', action, params }` immediately after `dispatchMessage` returns its `DispatcherDecision`, before the action-branch switch.
  - Emit `{ kind: 'persist', op: 'logMeasurement' }` before each of the two `store.logMeasurement` calls at `src/telegram/dispatcher-runner.ts:1083` and `:1106`.

- `src/agents/plan-flow.ts`:
  - Thread `onTrace` through `ConfirmPlanInput` (or the equivalent deps surface already threaded through the flow).
  - Emit `{ kind: 'persist', op: 'confirmPlanSessionReplacing' }` before the call at `src/agents/plan-flow.ts:560` and `{ kind: 'persist', op: 'confirmPlanSession' }` before the call at `:563`.

- `src/plan/mutate-plan-applier.ts`:
  - Thread `onTrace` through the applier's deps bundle.
  - Emit `{ kind: 'persist', op: 'confirmPlanSessionReplacing' }` before the call at `src/plan/mutate-plan-applier.ts:353`.

- `src/agents/plan-proposer.ts` (`src/agents/plan-proposer.ts:142-180` — the inline `validateProposal` retry loop):
  - After each validation failure, emit `{ kind: 'retry', validator: 'plan-proposer', attempt, errors: validation.errors }` through the `deps.onTrace` callback (thread `onTrace` into the proposer via its existing deps bundle or as a new arg on `proposePlan()`).

- `src/agents/plan-reproposer.ts` (`src/agents/plan-reproposer.ts:121-` — the inline re-proposer retry):
  - Same pattern: emit `{ kind: 'retry', validator: 'plan-reproposer', attempt, errors }` on retry.

- `src/agents/recipe-flow.ts` (`src/agents/recipe-flow.ts:214+` — the `validateRecipe` correction loop):
  - Emit `{ kind: 'retry', validator: 'recipe-generator', attempt, errors: validation.errors }` on each correction round.

- `src/qa/gate.ts` is UNUSED today (`qaGate` is exported but has no call sites in `src/`). We do NOT add trace hooks to `gate.ts` in this plan; when the "Generalize the QA-gate-and-retry pattern across all LLM call sites" work lands (named out-of-scope in design doc 004), the trace hook can move to `qaGate` and the three inline emissions can be deleted. Until then, the three inline sites above are the source of truth for `validatorRetries` entries.

- `test/scenarios.test.ts`:
  - After `runScenario(spec, recorded)` returns, build the `AssertionsContext`.
  - Call `runGlobalInvariants(recorded, result.outputs)` and `assert.deepStrictEqual(results.filter(r => !r.passed), [], 'global invariants failed')` — presented as a single assertion with all failing invariants in the message.
  - If `assertions.ts` present and exports `assertBehavior`, call `await assertBehavior(ctx)` inside the test body. Exceptions propagate to `node:test` as assertion failures with file+line context.
  - The three existing `deepStrictEqual` checks (outputs, finalSession, finalStore) stay unchanged. Global invariants + assertBehavior run BEFORE them so the failure report surfaces semantic issues first when both diverge.

- `test/scenarios/014-proposer-orphan-fill/fixture-assertions.ts`:
  - Renamed to `assertions.ts` and re-shaped to export `purpose`, `assertBehavior`, and `assertFixtureEdits` (existing logic preserved).
  - The file move is a rename: content reorganized, existing `FIXTURE_EDIT_ERROR` + helpers kept.

- `package.json`:
  - Add script: `"review": "tsx --import ./test/setup.ts src/harness/review.ts"`.

- `docs/product-specs/testing.md`:
  - Replace the ad-hoc `node -e "..."` quick-verification script with a reference to `npm run review -- <scenario>`.
  - Add a new § "Certification workflow" documenting the `generate → review → --accept` sequence.
  - Update § "Scenarios with manually edited fixtures" to use `assertions.ts` in place of `fixture-assertions.ts`; reference design doc 004 for rationale.
  - Re-emphasize that `npm test` green ≠ certified; review status is the separate signal.

- `docs/design-docs/004-behavioral-certification-harness.md`:
  - Add a "Shipped in Plan 031 (docs/plans/completed/031-behavioral-certification-harness.md)" note at the top when this plan moves to `completed/`.

- `CLAUDE.md`:
  - Under § "Debug workflow", add one paragraph that `npm run review -- <scenario>` is now the primary tool for reading a scenario's behavior (purpose + probe report + certification status).

---

### Phase 1: Assertions context + loader module

**Goal:** Introduce the `AssertionsContext` type and rename the existing `fixture-assertions.ts` loader to `assertions-loader.ts` with the richer export surface. No behavioral change yet — just scaffolding. All existing scenarios continue to pass because `assertBehavior` is called only if the scenario exports it.

**Files:**
- Create: `src/harness/assertions-context.ts`
- Create: `src/harness/assertions-loader.ts`
- Delete: `src/harness/fixture-assertions.ts`
- Modify: `src/harness/types.ts`, `src/harness/index.ts`, `src/harness/replay.ts`, `test/scenarios.test.ts`

**Steps:**

- [ ] **Step 1.1:** Define the `AssertionsContext` interface in `src/harness/assertions-context.ts`:

  ```typescript
  import type { Scenario, CapturedOutput } from './types.js';
  import type { ExecTrace } from './trace.js';
  
  /**
   * Passed to `assertBehavior(ctx)`. All fields are readonly — assertions
   * are semantic checks over the scenario's outcome; they must not mutate
   * anything.
   */
  export interface AssertionsContext {
    readonly spec: Scenario;
    readonly outputs: readonly CapturedOutput[];
    readonly finalSession: unknown;
    readonly finalStore: unknown;
    readonly sessionAt?: readonly unknown[];
    readonly execTrace: ExecTrace;
  
    // Convenience accessors over finalStore, computed on demand.
    readonly activeSession: () => unknown;        // first non-superseded planSession, or undefined
    readonly batches: () => readonly unknown[];   // finalStore.batches
    readonly flexSlots: () => readonly unknown[]; // activeSession.flexSlots
  
    // Convenience accessors over outputs.
    readonly lastOutput: () => CapturedOutput | undefined;
    readonly replyContaining: (needle: string) => CapturedOutput | undefined;
  }
  
  export function buildAssertionsContext(args: {
    spec: Scenario;
    outputs: readonly CapturedOutput[];
    finalSession: unknown;
    finalStore: unknown;
    sessionAt?: readonly unknown[];
    execTrace: ExecTrace;
  }): AssertionsContext;
  ```
  
  Body of `buildAssertionsContext` is straightforward: freeze inputs, return an object with getters that traverse `finalStore` for the computed accessors. Safe against missing fields (returns undefined / empty array rather than throwing).

- [ ] **Step 1.2:** Create `src/harness/trace.ts` with just the types and a minimal `HarnessTraceCollector` that currently always returns an empty `ExecTrace`. This lets `AssertionsContext` type-resolve even though Phase 3 is when trace collection is wired. The module's public API is stable from day one.

- [ ] **Step 1.3:** Migrate `src/harness/fixture-assertions.ts` to `src/harness/assertions-loader.ts`:

  ```typescript
  import { stat } from 'node:fs/promises';
  import { join } from 'node:path';
  import { pathToFileURL } from 'node:url';
  import type { RecordedScenario } from './types.js';
  import type { AssertionsContext } from './assertions-context.js';
  
  export type AssertBehavior = (ctx: AssertionsContext) => void | Promise<void>;
  export type AssertFixtureEdits = (recorded: RecordedScenario) => void | Promise<void>;
  
  export interface LoadedAssertions {
    path: string;
    purpose?: string;
    assertBehavior?: AssertBehavior;
    assertFixtureEdits?: AssertFixtureEdits;
  }
  
  /**
   * Load `<dir>/assertions.ts` if present. Returns undefined if the file
   * is absent (legacy scenarios). Throws with a clear message if the file
   * exists but exports an invalid surface (e.g. `assertBehavior` isn't a
   * function).
   */
  export async function loadAssertions(dir: string): Promise<LoadedAssertions | undefined>;
  
  /**
   * Backward-compat shim for the old `fixture-assertions.ts` filename. The
   * runner calls this in two places (scenarios.test.ts and replay.ts); those
   * call sites keep working because the helper internally delegates to
   * `loadAssertions` and invokes `assertFixtureEdits` only when the loaded
   * module defines it.
   */
  export async function runFixtureEditAssertions(
    dir: string,
    recorded: RecordedScenario,
  ): Promise<void>;
  ```

- [ ] **Step 1.4:** Update `src/harness/types.ts`: add `execTrace?: ExecTrace` to `ScenarioResult`; re-export `ExecTrace`, `TraceEvent` from `./trace.js`, `AssertionsContext` from `./assertions-context.js`.

- [ ] **Step 1.5:** Update `src/harness/index.ts`: export the new modules. Do NOT re-export anything named `fixture-assertions` — the old filename is gone. Keep the `runFixtureEditAssertions` symbol exported (its implementation just moved).

- [ ] **Step 1.6:** Update `src/harness/replay.ts`: change `import { runFixtureEditAssertions } from './fixture-assertions.js';` to `import { runFixtureEditAssertions } from './assertions-loader.js';`. No other change.

- [ ] **Step 1.7:** Update `test/scenarios.test.ts`: change the import to point at `assertions-loader.js`; NO behavioral change yet — `assertBehavior` integration lands in Phase 5 after invariants (Phase 2), execTrace (Phase 3), and domain helpers (Phase 4) are in place.

- [ ] **Step 1.8:** Rename scenario 014's `fixture-assertions.ts` to `assertions.ts` via `git mv`, preserving all existing content (file-doc comment, `FIXTURE_EDIT_ERROR`, the helpers, `assertFixtureEdits`). At the top of the file (right after the imports), add the stub `purpose` + `assertBehavior` exports — the real bodies land in Phase 5:
  ```typescript
  // Temporary stubs — Phase 5 replaces these with real bodies.
  export const purpose = 'TODO: Phase 5 migration';
  export function assertBehavior(_ctx: unknown): void {
    // Phase 5 will compose assertPlanningHealthy + execTrace checks here.
  }
  // `assertFixtureEdits` remains defined below; already exported.
  ```
  The rename ensures the runner still finds the scenario's fixture-edit guardrail through `runFixtureEditAssertions` (which now reads `assertions.ts` instead of `fixture-assertions.ts`).

- [ ] **Step 1.9:** Run `npm test`. Expected: all scenarios pass, including 014 (which now loads from `assertions.ts` instead of `fixture-assertions.ts`). If any scenario fails because the loader searches for the wrong filename, fix the loader.

- [ ] **Step 1.10:** Commit: `harness: rename fixture-assertions to assertions-loader, add AssertionsContext scaffolding`.

---

### Phase 2: Global invariants module

**Goal:** Implement GI-01..GI-06 and wire them into `npm test`. Every existing scenario must pass all invariants; any failure indicates a latent bug the design doc explicitly flags as expected.

**Files:**
- Create: `src/harness/invariants.ts`
- Create: `test/unit/invariants.test.ts`
- Modify: `test/scenarios.test.ts`, `src/harness/index.ts`

**Steps:**

- [ ] **Step 2.1:** Implement `src/harness/invariants.ts`:

  ```typescript
  import type { CapturedOutput, RecordedScenario } from './types.js';
  
  export interface InvariantResult {
    id: string;
    passed: boolean;
    message?: string;
  }
  
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;
  const SHA256_RE = /^[0-9a-f]{64}$/i;
  
  export function runGlobalInvariants(
    recorded: RecordedScenario,
    outputs: readonly CapturedOutput[],
  ): InvariantResult[] {
    return [
      invariantRecordingWellFormed(recorded),
      invariantNoFallbackMessages(outputs),
      invariantNoUndefinedOrStringifiedObjects(outputs),
      invariantNoEmptyReplies(outputs),
      invariantKeyboardsNonEmpty(outputs),
      invariantUuidsNormalized(recorded),
    ];
  }
  
  // each invariant returns { id: 'GI-0x-slug', passed, message? }
  ```
  
  Each invariant is <15 lines. Messages name the offending `output[i]` index or `llmFixtures[j]` index to make diagnosis cheap. Implementation notes:
  
  - **GI-01** checks `generatedAt` via `ISO_DATE_RE`, `specHash` via `SHA256_RE`, and existence of `llmFixtures`, `expected.outputs`, `expected.finalSession`.
  - **GI-02** matches `/Something went wrong/i` against every `output.text`.
  - **GI-03** matches `\bundefined\b` and `\[object Object\]` — literal checks, no regex flags needed beyond word boundaries.
  - **GI-04** checks `output.text.trim().length > 0`.
  - **GI-05** walks `output.keyboard`: for `kind: 'reply'` check `buttons.length > 0 && buttons.every(row => row.length > 0)`; for `kind: 'inline'` same shape on the button objects.
  - **GI-06** runs `UUID_RE` against `JSON.stringify(recorded.expected)`. If it matches, the message includes the first 120 chars of the match context so the offending field is greppable.

- [ ] **Step 2.2:** Add `test/unit/invariants.test.ts` covering positive + negative case for each of GI-01..GI-06. Use small hand-built `RecordedScenario` fixtures (no need for full scenarios — just the minimum shape each invariant touches).

- [ ] **Step 2.3:** Wire invariants into `test/scenarios.test.ts`:

  ```typescript
  import { runGlobalInvariants } from '../src/harness/index.js';
  // ...
  test(`scenario: ${spec.name}`, async () => {
    // ... existing loader / runFixtureEditAssertions / runScenario ...
    
    // Global invariants — run BEFORE deepStrictEqual so semantic failures
    // surface first when both diverge.
    const invariantResults = runGlobalInvariants(recorded, result.outputs);
    const failed = invariantResults.filter(r => !r.passed);
    assert.deepStrictEqual(
      failed,
      [],
      `global invariants failed:\n${failed.map(r => `  [${r.id}] ${r.message}`).join('\n')}`,
    );
    
    // ... then existing outputs / finalSession / finalStore deepStrictEqual ...
  });
  ```

- [ ] **Step 2.4:** Re-export `runGlobalInvariants`, `InvariantResult` from `src/harness/index.ts`.

- [ ] **Step 2.5:** Run `npm test`. **Expected outcome: every scenario passes all invariants.** If any scenario fails, investigate: either the invariant is not truly global (refine it) or the scenario has a latent bug (fix the code and regenerate — per design decision and per the "fix code first" rule in `docs/product-specs/testing.md` § Verification protocol step 5). Do NOT weaken an invariant to make a scenario pass if the failure is a real bug.

- [ ] **Step 2.6:** If any scenario was regenerated during Step 2.5, review each regeneration serially using the 5-step protocol in `docs/product-specs/testing.md` § "Verifying recorded output". Do NOT batch-review. Commit each fix + its regenerated recording together.

- [ ] **Step 2.7:** Commit: `harness: add six global invariants enforced on every scenario`.

---

### Phase 3: BotCore execTrace scaffolding

**Goal:** Add `onTrace` to `BotCoreDeps` and emit structured events at four hook kinds (handler entry, dispatcher decision, validator retry, store mutation). Production `grammY` adapter does not pass `onTrace`, so emission is a no-op in production. Harness runner wires a `HarnessTraceCollector` and surfaces `result.execTrace`.

**Files:**
- Modify: `src/harness/trace.ts` — flesh out `HarnessTraceCollector.summarize()`.
- Modify: `src/telegram/core.ts` — extend `BotCoreDeps` with optional `onTrace`; emit `handler` events at dispatch entry + each top-level case; emit `persist` before the `store.logMeasurement` call at `src/telegram/core.ts:791`.
- Modify: `src/telegram/dispatcher-runner.ts` — emit `dispatcher` event immediately after `dispatchMessage` returns its decision inside `runDispatcherFrontDoor`; emit `persist` before the two `store.logMeasurement` calls at `src/telegram/dispatcher-runner.ts:1083` and `:1106`.
- Modify: `src/agents/plan-flow.ts` — emit `persist` before the two `store.confirmPlanSession*` calls at `src/agents/plan-flow.ts:560` and `:563`. Thread `onTrace` through the flow's input/deps surface.
- Modify: `src/plan/mutate-plan-applier.ts` — emit `persist` before `store.confirmPlanSessionReplacing` at `src/plan/mutate-plan-applier.ts:353`. Thread `onTrace` from the caller.
- Modify: `src/agents/plan-proposer.ts` — emit `retry` in the inline `validateProposal` retry loop at `src/agents/plan-proposer.ts:142-180`. Thread `onTrace` through `ProposePlanInput`.
- Modify: `src/agents/plan-reproposer.ts` — emit `retry` in the inline retry loop at `src/agents/plan-reproposer.ts:121+`. Thread `onTrace` through the re-proposer's input type.
- Modify: `src/agents/recipe-flow.ts` — emit `retry` in the `validateRecipe` correction loop at `src/agents/recipe-flow.ts:214+`. Thread `onTrace` from the caller.
- Modify: `src/harness/runner.ts` — construct `HarnessTraceCollector`; pass `onTrace: collector.record` in `BotCoreDeps`; populate `result.execTrace = collector.summarize()`.
- Create: `test/unit/trace.test.ts`.

**Not modified:** `src/qa/gate.ts`. `qaGate` has zero call sites in `src/` today; instrumenting it would produce no trace coverage. When the "Generalize the QA-gate-and-retry pattern" work (out-of-scope for this plan; named in design doc 004) migrates the three inline loops to `qaGate`, the retry hooks can relocate there and the inline emissions can be deleted in the same change.

**Steps:**

- [ ] **Step 3.1:** Complete `src/harness/trace.ts`:

  ```typescript
  export type TraceEvent =
    | { kind: 'handler'; name: string }
    | { kind: 'dispatcher'; action: string; params?: unknown }
    | { kind: 'retry'; validator: string; attempt: number; errors: string[] }
    | { kind: 'persist'; op: string; argSummary?: string };
  
  export interface ExecTrace {
    readonly handlers: readonly string[];
    readonly dispatcherActions: readonly { action: string; params?: unknown }[];
    readonly validatorRetries: readonly { validator: string; attempt: number; errors: string[] }[];
    readonly persistenceOps: readonly { op: string; argSummary?: string }[];
  }
  
  export class HarnessTraceCollector {
    private events: TraceEvent[] = [];
    record = (event: TraceEvent): void => { this.events.push(event); };
    summarize(): ExecTrace {
      return {
        handlers: this.events.flatMap(e => e.kind === 'handler' ? [e.name] : []),
        dispatcherActions: this.events.flatMap(e => e.kind === 'dispatcher' ? [{ action: e.action, params: e.params }] : []),
        validatorRetries: this.events.flatMap(e => e.kind === 'retry' ? [{ validator: e.validator, attempt: e.attempt, errors: e.errors }] : []),
        persistenceOps: this.events.flatMap(e => e.kind === 'persist' ? [{ op: e.op, argSummary: e.argSummary }] : []),
      };
    }
  }
  ```

- [ ] **Step 3.2:** Add `test/unit/trace.test.ts`: record a mixed sequence, assert `summarize()` groups correctly and preserves order within each group.

- [ ] **Step 3.3:** Extend `BotCoreDeps` in `src/telegram/core.ts`:

  ```typescript
  export interface BotCoreDeps {
    llm: LLMProvider;
    recipes: RecipeDatabase;
    store: StateStoreLike;
    /** Optional hook for the harness to collect a runtime execution trace.
     *  Production grammY adapter does not set this; emission is a no-op. */
    onTrace?: (event: TraceEvent) => void;
  }
  ```

  Import `TraceEvent` from `../harness/trace.js`. This is a production-code import of a harness-adjacent type — keep the type in `harness/trace.ts` but accept that production imports it. An alternative is moving `TraceEvent` to a neutral location like `src/telemetry/trace.ts`; if that's preferred for layering cleanliness, do so in this step. **Recommendation:** keep it in `harness/trace.ts` to emphasize that the trace mechanism is a harness concern; production tolerates the import because the type is cheap.

- [ ] **Step 3.4:** Emit `handler` events at the four dispatch-entry cases in `core.ts:360-398` and at the start of each `handleCommand`, `handleCallback`, `handleMenu` callback branch. Example:

  ```typescript
  async function dispatch(update: HarnessUpdate, sink: OutputSink): Promise<void> {
    deps.onTrace?.({ kind: 'handler', name: `dispatch:${update.type}` });
    switch (update.type) { /* ... */ }
  }
  ```

  Inside `handleCallback`, after the `parseCallback` extraction, emit `{ kind: 'handler', name: `callback:${kind}` }` (where `kind` is the resolved callback prefix — `cv`, `rv`, `plan_approve`, etc.). Keep these at the single point where the case routes; do NOT try to instrument every nested helper.

- [ ] **Step 3.5:** Emit `persist` events immediately before each `store.*` MUTATION call. `StateStoreLike` (`src/state/store.ts:45`) defines exactly two mutation methods today — `confirmPlanSession` and `confirmPlanSessionReplacing` — plus `logMeasurement` (defined in the same interface further down). Read-only queries (`getPlanSession`, `getRunningPlanSession`, `getBatchesOverlapping`, `getBatchesByPlanSessionId`, `getBatch`, `getMeasurements`, `getLatestMeasurement`, `getTodayMeasurement`, `getLatestHistoricalPlanSession`, `getRecentPlanSessions`, `getFuturePlanSessions`) are NOT traced.

  **`completeActivePlans` and `savePlan` are NOT part of today's `StateStoreLike`** — they belonged to the pre-Plan 007 interface that the rolling-horizon model replaced. The earlier draft of this plan referenced them in error; the corrected canonical list is `confirmPlanSession`, `confirmPlanSessionReplacing`, `logMeasurement`.

  **Write call sites to instrument** (exhaustive as of HEAD — grep `store\.(confirmPlanSession|confirmPlanSessionReplacing|logMeasurement)` to re-verify before editing):

  | Site | Method | Op to emit |
  |---|---|---|
  | `src/agents/plan-flow.ts:560` | `confirmPlanSessionReplacing` | `confirmPlanSessionReplacing` |
  | `src/agents/plan-flow.ts:563` | `confirmPlanSession` | `confirmPlanSession` |
  | `src/plan/mutate-plan-applier.ts:353` | `confirmPlanSessionReplacing` | `confirmPlanSessionReplacing` |
  | `src/telegram/dispatcher-runner.ts:1083` | `logMeasurement` | `logMeasurement` |
  | `src/telegram/dispatcher-runner.ts:1106` | `logMeasurement` | `logMeasurement` |
  | `src/telegram/core.ts:791` | `logMeasurement` | `logMeasurement` |

  Pattern per site:

  ```typescript
  deps.onTrace?.({ kind: 'persist', op: 'confirmPlanSession' });
  await store.confirmPlanSession(/* ... */);
  ```

  For sites that don't already have `deps.onTrace` in scope (`plan-flow.ts` and `mutate-plan-applier.ts`), thread `onTrace` down from the caller: add `onTrace?: (event: TraceEvent) => void` to the relevant input interface (e.g., `ConfirmPlanInput`, `MutateApplierDeps`) and pass it from the caller chain originating at `BotCoreDeps.onTrace`. Threading is mechanical — follow the existing `llm` / `store` / `recipes` path already threaded through these files.

  `argSummary` is optional — include short summaries like `{ planSessionId: '…', batchCount: 8 }` only where they add diagnostic value. Omit otherwise.

- [ ] **Step 3.6:** In `src/telegram/dispatcher-runner.ts`, emit `dispatcher` events. The `runDispatcherFrontDoor` function receives the decision from `dispatchMessage`; immediately before the action-branch switch, emit:

  ```typescript
  deps.onTrace?.({ kind: 'dispatcher', action: decision.action, params: decision.params });
  ```

  The cancel-meta-intent short-circuit path (scenario 041) and the numeric pre-filter (scenario 042) do NOT reach this code path, so they correctly emit no `dispatcher` event — matches the design doc's expectation that execTrace reflects what actually happened.

- [ ] **Step 3.7:** Instrument the three inline validator-retry sites (not `qaGate`, which is currently unused — see "Files to modify" above for rationale). For each site:

  **`src/agents/plan-proposer.ts` (proposePlan function, retry loop at lines ~142-180):**
  
  Thread `onTrace?: (event: TraceEvent) => void` into the function's input interface (either on `ProposePlanInput` or as a sibling arg; pick whichever is less disruptive to existing callers). Emit on each retry attempt:
  
  ```typescript
  if (!validation.valid) {
    input.onTrace?.({
      kind: 'retry',
      validator: 'plan-proposer',
      attempt: 2,  // first retry is attempt 2 in the qaGate convention
      errors: validation.errors,
    });
    // ... existing retry code ...
  }
  ```
  
  If the retry itself fails a second time, emit a second event with `attempt: 3`. Use the same `attempt` counter convention as `qaGate` (initial = 1, first retry = 2, etc.) for consistency if/when the refactor lands.

  **`src/agents/plan-reproposer.ts` (reProposePlan function, retry loop at lines ~121+):**
  
  Same pattern with `validator: 'plan-reproposer'`.

  **`src/agents/recipe-flow.ts` (the validateRecipe correction loop at lines ~214+):**
  
  Same pattern with `validator: 'recipe-generator'`. Emit once per correction round.

  In each case, the caller chain (plan-flow → proposePlan, plan-flow → reProposePlan, recipe-flow functions) must pass `onTrace` through from `BotCoreDeps.onTrace`. Grep for the call sites: `proposePlan(`, `reProposePlan(`, and the recipe-flow helper that contains the `validateRecipe` loop. Threading is mechanical: add `onTrace?: (event: TraceEvent) => void` to the function's input type, pass it from the caller.

- [ ] **Step 3.8:** Do NOT modify `src/qa/gate.ts`. See "Files to modify" above for why. The three inline sites cover every real retry in today's codebase.

- [ ] **Step 3.9:** In `src/harness/runner.ts`, construct and wire the collector:

  ```typescript
  import { HarnessTraceCollector } from './trace.js';
  
  export async function runScenario(spec: Scenario, recorded: RecordedScenario): Promise<ScenarioResult> {
    // ... existing clock.freeze, recipe, llm, store setup ...
    const traceCollector = new HarnessTraceCollector();
    const deps: BotCoreDeps = { llm, recipes, store, onTrace: traceCollector.record };
    // ... existing core construction, event loop ...
    
    const result: ScenarioResult = {
      outputs: normalizeUuids(JSON.parse(JSON.stringify(sink.captured))),
      finalSession: normalizeUuids(JSON.parse(JSON.stringify(core.session))),
      finalStore: normalizeUuids(JSON.parse(JSON.stringify(store.snapshot()))),
      execTrace: traceCollector.summarize(),  // NEW — runtime only, not compared
    };
    if (spec.captureStepState) result.sessionAt = sessionAt;
    return result;
  }
  ```

- [ ] **Step 3.10:** Run `npm test`. All scenarios should still pass — `execTrace` is new-shape and not compared in any existing assertion. The three existing `deepStrictEqual` checks on `outputs`, `finalSession`, `finalStore` don't see it.

- [ ] **Step 3.11:** Commit: `harness: add execTrace via onTrace hook; four event kinds (handler, dispatcher, retry, persist)`.

---

### Phase 4: Domain helper library

**Goal:** Implement `assertPlanningHealthy(ctx)` as the first reusable domain helper, composed of seven primitives mirroring the 5-step verification protocol's checks. Scenarios opt in by calling these from their `assertBehavior`.

**Files:**
- Create: `src/harness/domain-helpers.ts`
- Create: `test/unit/domain-helpers.test.ts`
- Modify: `src/harness/index.ts`

**Steps:**

- [ ] **Step 4.1:** Draft `src/harness/domain-helpers.ts` with the seven primitives. Each is a top-level exported function taking `ctx: AssertionsContext` and throwing `Error` on failure with an actionable message that names the offending batch/slot/day.

  ```typescript
  import type { AssertionsContext } from './assertions-context.js';
  
  /** Top-level composed check for planning scenarios. Calls every primitive
   *  in sequence; throws on the first failure. */
  export function assertPlanningHealthy(ctx: AssertionsContext): void;
  
  /** All 14 slots (7 days × lunch + dinner) of the active session's horizon
   *  have exactly one source: batch, event, flex, or pre-committed. */
  export function assertSlotCoverage(ctx: AssertionsContext): void;
  
  /** No batch has `actualPerServing.calories === 0`. */
  export function assertNoGhostBatches(ctx: AssertionsContext): void;
  
  /** No day × meal slot has zero sources — composed into assertSlotCoverage
   *  but exported separately for scenarios that want only orphan checks. */
  export function assertNoOrphanSlots(ctx: AssertionsContext): void;
  
  /** No day × meal slot has two or more sources. */
  export function assertNoDoubleBooking(ctx: AssertionsContext): void;
  
  /** Every batch has 1 ≤ servings ≤ 3. Plan 024's proposer explicitly allows
   *  1-serving batches as a last-resort when no multi-serving arrangement
   *  fits (see `src/agents/plan-proposer.ts:231,241` — "Servings range: 1 to
   *  3. Prefer 2-3 serving batches. 1-serving is allowed only when no multi-
   *  serving arrangement fits"). Scenarios that explicitly want to guard
   *  against 1-serving batches in their particular setup can add that check
   *  in their own `assertBehavior`. */
  export function assertBatchSizesSane(ctx: AssertionsContext): void;
  
  /** For every batch, cookDay === eatingDays[0]. */
  export function assertCookDayFirstEating(ctx: AssertionsContext): void;
  
  /** No output.text contains the ⚠️ glyph in a weekly-totals context, AND
   *  no "below target" / "deviate" language. Absorbs the "weekly totals
   *  within ±3%" check via the proposer's own warning emission. */
  export function assertWeeklyTotalsAbsorbed(ctx: AssertionsContext): void;
  ```

  Each primitive's implementation logic mirrors the corresponding check in `docs/product-specs/testing.md` § "Verifying recorded output" steps 2 and 3. The `node -e "..."` quick-verification script at the end of that section is the direct reference implementation for `assertSlotCoverage` and `assertNoGhostBatches`.

- [ ] **Step 4.2:** `assertPlanningHealthy(ctx)` composes all seven primitives in a fixed sequence, catching `Error` from each and aggregating into a single thrown error with all failure messages:

  ```typescript
  export function assertPlanningHealthy(ctx: AssertionsContext): void {
    const primitives = [
      assertSlotCoverage,
      assertNoGhostBatches,
      assertNoOrphanSlots,
      assertNoDoubleBooking,
      assertBatchSizesSane,
      assertCookDayFirstEating,
      assertWeeklyTotalsAbsorbed,
    ];
    const errors: string[] = [];
    for (const p of primitives) {
      try { p(ctx); }
      catch (err) { errors.push(err instanceof Error ? err.message : String(err)); }
    }
    if (errors.length > 0) {
      throw new Error(`assertPlanningHealthy failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }
  }
  ```

  Aggregating vs short-circuiting: aggregate. A scenario with three planning failures should see all three in the single failure output, not require three fix-regenerate-rerun cycles.

- [ ] **Step 4.3:** Add `test/unit/domain-helpers.test.ts` covering each primitive's positive and negative case. Each test builds a minimal `AssertionsContext` (using `buildAssertionsContext` with hand-shaped objects) and asserts the primitive throws or returns as expected.

- [ ] **Step 4.4:** Re-export the helpers from `src/harness/index.ts`.

- [ ] **Step 4.5:** Run `npm test`. Nothing in the main suite changes yet (helpers are unused until Phase 5 migrates 014 to call them).

- [ ] **Step 4.6:** Commit: `harness: add domain-helpers with assertPlanningHealthy + 7 primitives`.

---

### Phase 5: Migrate scenario 014 to assertions.ts

**Goal:** Replace scenario 014's stub `assertions.ts` (from Phase 1) with a real implementation exporting `purpose` + `assertBehavior` + `assertFixtureEdits`. This is the reference example for audit cycle one.

**Files:**
- Modify: `test/scenarios/014-proposer-orphan-fill/assertions.ts`

**Steps:**

- [ ] **Step 5.1:** Replace `test/scenarios/014-proposer-orphan-fill/assertions.ts` with:

  ```typescript
  /**
   * Scenario 014 — proposer validator retry.
   *
   * Load-bearing claim: when the proposer's first response underfills the
   * week (fixture-edited to leave chicken lunch on Mon/Tue only, salmon
   * missing Wed), validateProposal catches it and the retry fills the gap.
   */
  
  import { assertPlanningHealthy } from '../../../src/harness/domain-helpers.js';
  import type {
    AssertionsContext,
    RecordedScenario,
  } from '../../../src/harness/index.js';
  
  export const purpose =
    'When the proposer underfills the week, the QA gate catches it and ' +
    'the proposer retries; the retry response covers every slot.';
  
  export function assertBehavior(ctx: AssertionsContext): void {
    // 1. The overall plan must be healthy — no ghost batches, no orphans,
    //    no double-booking, cook days = first eating days, weekly totals
    //    within tolerance. This proves the retry succeeded.
    assertPlanningHealthy(ctx);
  
    // 2. The retry must have actually happened — execTrace must show a
    //    plan-proposer retry with at least one attempt.
    const retries = ctx.execTrace.validatorRetries.filter(r => r.validator === 'plan-proposer');
    if (retries.length === 0) {
      throw new Error(
        'Expected at least one plan-proposer retry in execTrace.validatorRetries; ' +
        'got none. Did the fixture edits get replaced by a valid regeneration?',
      );
    }
  
    // 3. The session must have been persisted via confirmPlanSession.
    const persisted = ctx.execTrace.persistenceOps.some(o => o.op === 'confirmPlanSession');
    if (!persisted) {
      throw new Error('Expected confirmPlanSession persistence op in execTrace; got none.');
    }
  }
  
  // --- Fixture-edit guardrail (unchanged from Plan 017) -----------------------
  
  const FIXTURE_EDIT_ERROR = `Scenario 014 fixture edits are missing. Run:
    npm run test:generate -- 014-proposer-orphan-fill --regenerate
  Then re-apply fixture-edits.md and run:
    npm run test:replay -- 014-proposer-orphan-fill`;
  
  // ... existing `assertFixtureEdits` body preserved from the old file ...
  export function assertFixtureEdits(recorded: RecordedScenario): void {
    // [body from the old fixture-assertions.ts, unchanged]
  }
  ```

  Preserve the existing `assertFixtureEdits` body byte-for-byte (copy from the old file's git history if needed). Do NOT rewrite it — it's correct and tested.

- [ ] **Step 5.2:** Wire `assertBehavior` into `test/scenarios.test.ts` at the same point where invariants run:

  ```typescript
  // after global invariants check, before deepStrictEqual
  const loadedAssertions = await loadAssertions(loadedDir);
  if (loadedAssertions?.assertBehavior) {
    const ctx = buildAssertionsContext({
      spec,
      outputs: result.outputs,
      finalSession: result.finalSession,
      finalStore: result.finalStore,
      sessionAt: result.sessionAt,
      execTrace: result.execTrace!,  // runner always populates
    });
    await loadedAssertions.assertBehavior(ctx);
  }
  ```

- [ ] **Step 5.3:** Run `npm test`. Scenario 014 must now:
  - Pass `runFixtureEditAssertions` (edits present).
  - Pass `runGlobalInvariants` (no fallback messages, no undefined, etc.).
  - Pass `assertBehavior` (planning healthy, retry in trace, persistence op in trace).
  - Pass the three existing `deepStrictEqual` checks.

  If `assertBehavior` fails on `plan-proposer` retry lookup, check the `validator` string in the `onTrace({ kind: 'retry', validator: ... })` call in `src/agents/plan-proposer.ts`'s inline retry loop (it must match exactly `'plan-proposer'` — the literal the assertion greps for). Adjust either the assertion or the emission.

- [ ] **Step 5.4:** Commit: `scenario 014: migrate fixture-assertions.ts → assertions.ts with purpose + assertBehavior`.

---

### Phase 6: Certification stamp format

**Goal:** Define `certification.json`, implement hashing/loading/derivation, and unit-test the status matrix. No runner integration yet — that lands in the review CLI (Phase 7+).

**Files:**
- Create: `src/harness/certification.ts`
- Create: `test/unit/certification.test.ts`
- Modify: `src/harness/index.ts`

**Steps:**

- [ ] **Step 6.1:** Implement `src/harness/certification.ts`:

  ```typescript
  import { readFile, stat, writeFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import { createHash } from 'node:crypto';
  
  export type CertificationStoredStatus = 'certified' | 'obsolete';
  export type CertificationStatus = 'certified' | 'needs-review' | 'uncertified' | 'obsolete';
  
  export interface CertificationStamp {
    reviewedAt: string;       // ISO
    specHash: string;         // sha256 of spec.ts bytes
    assertionsHash: string;   // sha256 of assertions.ts bytes
    recordingHash: string;    // sha256 of recorded.json bytes
    status: CertificationStoredStatus;
  }
  
  export interface CurrentHashes {
    specHash: string;
    assertionsHash: string;   // sha256 of assertions.ts if present, else ''
    recordingHash: string;
  }
  
  /** sha256 hex over the raw file bytes. Throws ENOENT for missing files
   *  unless `optional === true`, in which case returns '' for absent. */
  export async function hashFile(path: string, optional = false): Promise<string>;
  
  /** Compute current on-disk hashes for a scenario directory. */
  export async function currentHashes(dir: string): Promise<CurrentHashes>;
  
  /** Load `<dir>/certification.json` if present. Returns undefined when absent. */
  export async function loadStamp(dir: string): Promise<CertificationStamp | undefined>;
  
  /** Write `<dir>/certification.json`. Pretty-printed with trailing newline. */
  export async function writeStamp(dir: string, stamp: CertificationStamp): Promise<void>;
  
  /** Derive the review-surface status from the stored stamp + current hashes.
   *  Rules (per design doc § "Reviewing the suite"):
   *    - absent stamp       → 'uncertified'
   *    - stored 'obsolete'  → 'obsolete' (sticky; drift does not resurrect)
   *    - stored 'certified' + all three hashes match → 'certified'
   *    - stored 'certified' + any hash differs       → 'needs-review' */
  export function deriveStatus(
    stamp: CertificationStamp | undefined,
    current: CurrentHashes,
  ): CertificationStatus;
  ```

- [ ] **Step 6.2:** Write `test/unit/certification.test.ts` covering the five derivation cases:
  - Absent stamp → `uncertified`.
  - Stored `certified` + all hashes match → `certified`.
  - Stored `certified` + `specHash` differs → `needs-review`.
  - Stored `certified` + `assertionsHash` differs → `needs-review`.
  - Stored `certified` + `recordingHash` differs → `needs-review`.
  - Stored `obsolete` + all hashes match → `obsolete`.
  - Stored `obsolete` + any hash differs → `obsolete` (sticky).

- [ ] **Step 6.3:** Re-export from `src/harness/index.ts`.

- [ ] **Step 6.4:** Commit: `harness: add certification stamp format with 4-field status derivation`.

---

### Phase 7: Review CLI — suite-level list mode

**Goal:** `npm run review` (no arg) lists every scenario with derived status. `--needs-review`, `--status certified`, `--status obsolete` filter the output.

**Files:**
- Create: `src/harness/review.ts`
- Modify: `package.json`

**Steps:**

- [ ] **Step 7.1:** Create `src/harness/review.ts` skeleton with arg parser (pattern-match on `generate.ts:79-102`):

  ```typescript
  interface ReviewArgs {
    scenarioName?: string;           // positional, optional
    live: boolean;                    // --live
    accept: boolean;                  // --accept
    filterNeedsReview: boolean;       // --needs-review
    filterStatus?: CertificationStoredStatus;  // --status=certified|obsolete
  }
  
  function parseArgs(argv: string[]): ReviewArgs;
  ```

  Unknown flags fail loudly. `--live` + `--accept` combined throws with a clear message ("--live and --accept do not combine — certification reflects on-disk state, not live behavior").

- [ ] **Step 7.2:** Implement `listAllScenarios(args: ReviewArgs)`:

  ```typescript
  async function listAllScenarios(args: ReviewArgs): Promise<void> {
    const dirs = await discoverScenarios(SCENARIOS_ROOT);
    const rows: { name: string; status: CertificationStatus; purpose?: string }[] = [];
    for (const dir of dirs) {
      const name = basename(dir);
      const stamp = await loadStamp(dir);
      const current = await currentHashes(dir);
      const status = deriveStatus(stamp, current);
      const loaded = await loadAssertions(dir);
      rows.push({ name, status, purpose: loaded?.purpose });
    }
    
    const filtered = rows.filter(r => {
      if (args.filterNeedsReview) return r.status === 'uncertified' || r.status === 'needs-review';
      if (args.filterStatus) return r.status === args.filterStatus;
      return true;
    });
    
    // Print as a two-column table with a status summary row.
    const counts = countByStatus(rows);
    console.log(`Scenarios: ${rows.length} total — certified ${counts.certified}, ` +
                `needs-review ${counts['needs-review']}, uncertified ${counts.uncertified}, ` +
                `obsolete ${counts.obsolete}`);
    for (const r of filtered) {
      console.log(`  [${padStatus(r.status)}] ${r.name}${r.purpose ? '  — ' + r.purpose : ''}`);
    }
  }
  ```

  Output example:
  ```
  Scenarios: 62 total — certified 1, needs-review 0, uncertified 61, obsolete 0
    [certified   ] 014-proposer-orphan-fill  — When the proposer underfills...
    [uncertified ] 001-plan-week-happy-path
    [uncertified ] 002-plan-week-flex-move-regression
    ...
  ```

- [ ] **Step 7.3:** Add `"review": "tsx --import ./test/setup.ts src/harness/review.ts"` to `package.json` scripts.

- [ ] **Step 7.4:** Manual verification: run `npm run review`. Expected state depending on phase ordering:
  - **After Phase 7 alone:** All 62 scenarios listed, all `[uncertified]` (no stamp files exist yet — scenario 014's assertions.ts is present from Phase 5, but no `certification.json` has been written yet).
  - **After Phase 10 Step 10.4 lands:** Scenario 014 becomes `[certified]`; other 61 remain `[uncertified]`.
  
  Run `npm run review -- --needs-review` — expect all 62 (pre-Step 10.4) or 61 (post) scenarios listed. Run `npm run review -- --status obsolete` — expect empty output with the summary line.

- [ ] **Step 7.5:** Commit: `harness: add npm run review with suite-level list mode and filters`.

---

### Phase 8: Review CLI — scenario-level probe report

**Goal:** `npm run review <scenario>` runs the scenario in replay mode and prints a structured report covering purpose, transcript, derived plan view (for planning scenarios), invariant results, assertion results, execution trace summary, and certification status.

**Files:**
- Modify: `src/harness/review.ts`

**Steps:**

- [ ] **Step 8.1:** Implement `probeScenario(args: ReviewArgs)`:

  ```typescript
  async function probeScenario(args: ReviewArgs): Promise<void> {
    const dir = resolve(SCENARIOS_ROOT, args.scenarioName!);
    const { spec, recorded, error } = await loadScenario(dir);
    if (error || !recorded) throw new Error(error ?? 'no recording');
    
    const loaded = await loadAssertions(dir);
    
    // (Phase 9 adds the --live branch here; this step only handles replay.)
    await runFixtureEditAssertions(dir, recorded);
    const result = await runScenario(spec, recorded);
    
    renderProbeReport({ dir, spec, recorded, result, loaded });
  }
  ```

- [ ] **Step 8.2:** Implement `renderProbeReport`. Report structure (plain stdout, no ANSI colors for CI-friendliness — can revisit later):

  ```
  ══ Scenario: 014-proposer-orphan-fill ══
  
  Purpose:
    When the proposer underfills the week, the QA gate catches it and
    the proposer retries; the retry response covers every slot.
  
  ── Transcript (12 outputs) ──
    [1] text: "Welcome to Flexie. Tap 📋 Plan Week to begin."
        keyboard: reply [📋 Plan Week | 🛒 Shopping List | 📊 Progress | 📖 My Recipes]
    [2] text: "Keep breakfast the same as last week?"
        keyboard: inline [Keep | Change]
    ...
  
  ── Derived plan view ──
    (if assertPlanningHealthy is in assertBehavior or execTrace shows a plan mutation)
    Horizon: 2026-04-06 – 2026-04-12
    Mon lunch:   chicken-black-bean-avocado-rice-bowl    (batch)
    Mon dinner:  salmon-sweet-potato-broccoli             (batch)
    ...
  
  ── Global invariants ──
    [PASS] GI-01 recording-well-formed
    [PASS] GI-02 no-fallback-messages
    [PASS] GI-03 no-undefined-or-stringified-objects
    [PASS] GI-04 no-empty-replies
    [PASS] GI-05 keyboards-non-empty
    [PASS] GI-06 uuids-normalized
  
  ── assertBehavior ──
    [PASS] assertBehavior
  
  ── Execution trace ──
    Handlers:           dispatch:command, callback:plan_keep_breakfast, ...
    Dispatcher actions: (none — no free text in this scenario)
    Validator retries:  plan-proposer: attempt 2 (errors: ["slot 2026-04-08 dinner uncovered"])
    Persistence ops:    confirmPlanSession
  
  ── Certification status ──
    [certified] (stamp reviewedAt: 2026-04-13T12:34:56Z)
    specHash:       a1b2c3d4e5f6… (matches)
    assertionsHash: 9f8e7d6c5b4a… (matches)
    recordingHash:  1234567890ab… (matches)
  ```

  The "Derived plan view" section is conditional: include it only if `finalSession.planFlow` is non-null or `finalStore` shows at least one non-superseded plan session — i.e., planning scenarios. Non-planning scenarios (progress logging, shopping list, recipe library) skip this section silently.

- [ ] **Step 8.3:** The "Derived plan view" rendering: write a small helper `renderDerivedPlanView(ctx)` in `src/harness/domain-helpers.ts` that builds the 7-day × 2-meal grid from `finalStore.planSessions` + `finalStore.batches` + `finalSession.planFlow?.events` + `finalSession.planFlow?.flexSlots` + `finalSession.planFlow?.preCommittedSlots`. Output is one line per slot. This helper is deliberately NOT an assertion — it's a read-only rendering used by the review report.

- [ ] **Step 8.4:** Manual verification: `npm run review -- 014-proposer-orphan-fill` prints a report in the shape above. `npm run review -- 001-plan-week-happy-path` prints a report where `assertBehavior` section says `[SKIP] no assertions.ts` (legacy scenario without migration).

- [ ] **Step 8.5:** Commit: `harness: add scenario-level probe report to npm run review`.

---

### Phase 9: Review CLI — --live flag

**Goal:** `npm run review <scenario> --live` runs the scenario with the real `OpenAIProvider` instead of `FixtureLLMProvider`. Read-only: does not write `recorded.json`, does not touch `certification.json`. Probe report uses the fresh live results.

**Files:**
- Modify: `src/harness/review.ts`

**Steps:**

- [ ] **Step 9.1:** Extract the runner's wiring into a small helper that accepts an `LLMProvider` instance:

  ```typescript
  // src/harness/runner.ts — NEW exported helper
  export async function runScenarioWith(
    spec: Scenario,
    recorded: RecordedScenario | undefined,  // undefined ⇒ no fixture assertions
    llmFactory: (recorded: RecordedScenario | undefined) => LLMProvider,
  ): Promise<ScenarioResult>;
  ```

  Today's `runScenario(spec, recorded)` becomes a thin wrapper that calls `runScenarioWith(spec, recorded, r => new FixtureLLMProvider(r!.llmFixtures))`.

- [ ] **Step 9.2:** In `review.ts`, the `--live` branch:

  ```typescript
  if (args.live) {
    await confirmOrExit('Running --live calls the real LLM and costs money.', false);
    const result = await runScenarioWith(spec, recorded, () => new OpenAIProvider());
    renderProbeReport({ dir, spec, recorded, result, loaded, live: true });
    return;  // read-only — no writes
  }
  ```

  Reuse the confirmation prompt helper (`confirmOrExit`) from `generate.ts` — move it to a shared `src/harness/cli-utils.ts` module if it isn't already shared. Re-use of the prompt enforces that `--live` can't accidentally run in a tight loop.

- [ ] **Step 9.3:** The probe report in `--live` mode:
  - Transcript shows the LIVE outputs (not the recorded ones).
  - Global invariants run against the live outputs.
  - `assertBehavior` runs against the live ctx — this gives the agent a preview of whether the assertions still hold under new model behavior.
  - The certification section continues to display stamp status for the ON-DISK files — because `--live` does not touch disk, the stamp status is unchanged.
  - A banner at the top reads `── LIVE mode (read-only; no writes) ──`.

- [ ] **Step 9.4:** Manual verification: `npm run review -- 014-proposer-orphan-fill --live` calls the real LLM. The probe report shows live outputs. `recorded.json` and `certification.json` are unchanged on disk after the command exits (verify with `git status`).

- [ ] **Step 9.5:** Commit: `harness: add --live flag to npm run review (real LLM, read-only)`.

---

### Phase 10: Review CLI — --accept flag

**Goal:** `npm run review <scenario> --accept` verifies the on-disk spec/assertions/recording all replay cleanly and pass every check the test suite would apply, then hashes the three files and writes `certification.json` with `status: certified`. Requires `assertions.ts`. Rejects combination with `--live`. If any verification step fails, `--accept` refuses to stamp and prints the same failure the probe report would show.

**Why --accept must verify, not just stamp:** a pure stamp operation would let the agent certify a scenario whose recording is stale against the spec, whose global invariants fail, whose `assertBehavior` fails, or whose three `deepStrictEqual` checks don't hold. That defeats the point of certification. The design doc § "Reviewing one scenario" step 5 assumes the agent ran step 4 first and saw a clean probe report — but nothing in a pure-stamp `--accept` enforces that, and past incidents on this codebase show that agent discipline under time pressure is not a reliable gate. `--accept` therefore re-runs the verification itself. Cost is sub-second per scenario (replay + assertions); the guarantee is meaningful.

**Files:**
- Modify: `src/harness/review.ts`

**Steps:**

- [ ] **Step 10.1:** The `--accept` branch does a full verification pass, then stamps only if every check passes:

  ```typescript
  if (args.accept) {
    if (args.live) throw new Error('--live and --accept do not combine');
    if (!args.scenarioName) throw new Error('--accept requires a scenario name');
    
    const dir = resolve(SCENARIOS_ROOT, args.scenarioName);
    const { spec, recorded, error } = await loadScenario(dir);
    if (error) {
      // `loadScenario` returns an `error` string for missing or stale recordings.
      // A stale recording means the spec drifted; the agent must regenerate
      // before certifying.
      throw new Error(`Cannot certify: ${error}`);
    }
    if (!recorded) throw new Error(`Cannot certify: no recording at ${dir}/recorded.json`);
    
    const loaded = await loadAssertions(dir);
    if (!loaded || typeof loaded.assertBehavior !== 'function' || typeof loaded.purpose !== 'string') {
      throw new Error(
        `Cannot certify: ${dir}/assertions.ts is missing or does not export both ` +
        `\`purpose\` (string) and \`assertBehavior\` (function). Certification ` +
        `requires a full assertions module.`,
      );
    }
    
    // 1. Fixture-edit guardrail — e.g. scenario 014's manual edits must still be present.
    await runFixtureEditAssertions(dir, recorded);
    
    // 2. Replay the scenario in fixture mode (NOT --live — certification
    //    reflects on-disk state).
    const result = await runScenario(spec, recorded);
    
    // 3. Global invariants.
    const invariantResults = runGlobalInvariants(recorded, result.outputs);
    const failedInvariants = invariantResults.filter(r => !r.passed);
    if (failedInvariants.length > 0) {
      throw new Error(
        `Cannot certify: global invariants failed:\n` +
        failedInvariants.map(r => `  [${r.id}] ${r.message}`).join('\n'),
      );
    }
    
    // 4. assertBehavior — deterministic semantic checks over the replayed outcome.
    const ctx = buildAssertionsContext({
      spec,
      outputs: result.outputs,
      finalSession: result.finalSession,
      finalStore: result.finalStore,
      sessionAt: result.sessionAt,
      execTrace: result.execTrace!,
    });
    await loaded.assertBehavior(ctx);  // throws on failure; propagates here
    
    // 5. The three existing regression-net checks — outputs / finalSession /
    //    finalStore must equal the recorded expected state exactly. If they
    //    don't, the recording is drifting against current code behavior and
    //    the agent should regenerate before certifying.
    const mismatches: string[] = [];
    try { assert.deepStrictEqual(result.outputs, recorded.expected.outputs); }
    catch { mismatches.push('outputs diverged from recorded transcript'); }
    try { assert.deepStrictEqual(result.finalSession, recorded.expected.finalSession); }
    catch { mismatches.push('finalSession diverged from recorded state'); }
    try { assert.deepStrictEqual(result.finalStore, recorded.expected.finalStore); }
    catch { mismatches.push('finalStore diverged from recorded state'); }
    if (recorded.expected.sessionAt !== undefined) {
      try { assert.deepStrictEqual(result.sessionAt, recorded.expected.sessionAt); }
      catch { mismatches.push('sessionAt diverged from recorded per-step state'); }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Cannot certify: replay diverges from recording:\n  - ${mismatches.join('\n  - ')}\n` +
        `Regenerate via \`npm run test:generate -- ${spec.name} --regenerate\` first.`,
      );
    }
    
    // 6. All checks passed — stamp.
    const hashes = await currentHashes(dir);
    const stamp: CertificationStamp = {
      reviewedAt: new Date().toISOString(),
      specHash: hashes.specHash,
      assertionsHash: hashes.assertionsHash,
      recordingHash: hashes.recordingHash,
      status: 'certified',
    };
    await writeStamp(dir, stamp);
    
    console.log(`✓ Certified ${args.scenarioName} at ${stamp.reviewedAt}`);
    console.log(`  verification: replay ✓ invariants ✓ assertBehavior ✓ deepStrictEqual ✓`);
    console.log(`  specHash:       ${stamp.specHash.slice(0, 12)}…`);
    console.log(`  assertionsHash: ${stamp.assertionsHash.slice(0, 12)}…`);
    console.log(`  recordingHash:  ${stamp.recordingHash.slice(0, 12)}…`);
    return;
  }
  ```

  The verification steps (1-5) are exactly the subset of `npm test` that applies to one scenario. Running `--accept` on a green scenario is always safe; running it on a scenario where `npm test` would fail is blocked. The agent still decides **when** to certify — this just prevents certification of knowingly-broken state.

- [ ] **Step 10.2:** Guard the reverse direction too: if `--accept` is passed without a scenario name (suite-level accept), fail with a clear message ("--accept requires a scenario name"). Bulk certification is NOT supported and is out of scope.

- [ ] **Step 10.3:** Manual verification: `npm run review -- 014-proposer-orphan-fill --accept` writes `test/scenarios/014-proposer-orphan-fill/certification.json` with status `certified` and hashes matching the current on-disk files. Running `npm run review` afterward should show scenario 014 as `[certified]`.

- [ ] **Step 10.4:** Create the initial certification stamp for 014 via the command itself (proves `--accept` works end-to-end):
  
  ```bash
  npm run review -- 014-proposer-orphan-fill --accept
  ```
  
  Commit the generated `certification.json` as part of Phase 5's scenario 014 commit (retroactively, via a small follow-up commit — OR defer the commit to this step and let this phase own both the Phase 5 content and the stamp file).

- [ ] **Step 10.5:** Manual verification of the `needs-review` transition:
  
  1. Touch `test/scenarios/014-proposer-orphan-fill/assertions.ts` (add/remove a comment).
  2. Run `npm run review` — scenario 014 should now show as `[needs-review]` because `assertionsHash` changed.
  3. Run `npm run review -- 014-proposer-orphan-fill --accept` — stamp re-created with the new `assertionsHash`.
  4. Run `npm run review` — scenario 014 back to `[certified]`.
  5. `git checkout -- test/scenarios/014-proposer-orphan-fill/assertions.ts test/scenarios/014-proposer-orphan-fill/certification.json` to restore pre-test state.

- [ ] **Step 10.6:** Commit: `harness: add --accept flag to npm run review; stamp scenario 014 as initial certified example`.

---

### Phase 11: Documentation updates

**Goal:** `docs/product-specs/testing.md` and `CLAUDE.md` document the new workflow. Design doc 004 gets a shipped-in-plan-031 annotation. Scenario index.md and any cross-references are updated.

**Files:**
- Modify: `docs/product-specs/testing.md` — new § "Certification workflow", revised "Scenarios with manually edited fixtures" and "Quick verification script" subsections.
- Modify: `CLAUDE.md` — add a short paragraph under § "Debug workflow" pointing at `npm run review`. The existing "Docs index" table in this file already lists `docs/product-specs/testing.md`; no new row needed.
- Modify: `docs/design-docs/004-behavioral-certification-harness.md` — add "Shipped in Plan 031" status note when the plan moves to `completed/`.

**Steps:**

- [ ] **Step 11.1:** In `docs/product-specs/testing.md`, add a new § after "Verifying recorded output":

  > ## Certification workflow
  > 
  > `npm test` passing proves determinism. Certification proves behavioral correctness. The two are separate signals.
  > 
  > ### Reviewing the suite
  > 
  > `npm run review` lists every scenario with its derived certification status: `certified`, `needs-review`, `uncertified`, or `obsolete`. Filters: `--needs-review`, `--status certified|obsolete`.
  > 
  > ### Reviewing one scenario
  > 
  > `npm run review <scenario>` prints a probe report: purpose, transcript, derived plan view (planning scenarios), global-invariant results, `assertBehavior` results, execution trace summary, certification status.
  > 
  > Flags:
  > 
  > - `--live` — real LLM, read-only. No disk writes. Use to preview live behavior before regenerating.
  > - `--accept` — verify the scenario and stamp certification on success. Runs the full verification pipeline (stale-recording check, fixture-edit guardrail, replay, global invariants, `assertBehavior`, the three `deepStrictEqual` regression checks) and refuses to stamp if any step fails. On success, hashes the current on-disk `spec.ts` / `assertions.ts` / `recorded.json` into `certification.json` with `status: certified`. Requires `assertions.ts`.
  > 
  > `--live` and `--accept` do not combine.
  > 
  > **Why `--accept` verifies instead of pure-stamping:** a pure stamp would let a stale or broken scenario be marked certified — exactly the false signal this feature is designed to eliminate. Verification is sub-second (no LLM calls; fixture replay only), so there is no performance reason to skip it. Running `npm run review -- <scenario>` (no `--accept`) shows the same probe report without writing anything; run it first to see the report, then run `--accept` as the verification-and-stamp finalization step.
  > 
  > ### Authoring assertions
  > 
  > A scenario's `assertions.ts` exports:
  > 
  > - `purpose: string` — one sentence naming the scenario's load-bearing claim.
  > - `assertBehavior(ctx)` — deterministic semantic checks over `ctx.outputs`, `ctx.finalSession`, `ctx.finalStore`, `ctx.execTrace`, and (if opted in) `ctx.sessionAt`. Use domain helpers like `assertPlanningHealthy(ctx)` when applicable.
  > - `assertFixtureEdits(recorded)` — optional; only for fixture-edited scenarios (see § "Scenarios with manually edited fixtures").
  > 
  > ### Full workflow for new behavior
  > 
  > 1. Make the code change (prompt edit, fix, new feature).
  > 2. Write or update `assertions.ts` describing what the scenario's new purpose is.
  > 3. *Optional:* `npm run review -- <scenario> --live` to preview live behavior.
  > 4. `npm run test:generate -- <scenario> --regenerate` (delete `recorded.json` first).
  > 5. `npm run review -- <scenario>` to inspect the newly written recording — read the probe report, verify behavior.
  > 6. `npm run review -- <scenario> --accept` to verify + stamp. If step 5 was clean, this passes and writes `certification.json`. If something regressed between steps 5 and 6 (editing `assertions.ts`, changing `spec.ts`), `--accept` refuses and prints the specific failure.
  > 
  > Each step is a distinct agent decision. `--accept` is the last gate: it replays the scenario one more time and only stamps if every check the test suite would apply passes.

- [ ] **Step 11.2:** In `docs/product-specs/testing.md` § "Scenarios with manually edited fixtures": replace all references to `fixture-assertions.ts` with `assertions.ts`. Note that the `assertFixtureEdits` function is now one of three exports alongside `purpose` and `assertBehavior` in that file.

- [ ] **Step 11.3:** In `docs/product-specs/testing.md` § "Quick verification script": replace the ad-hoc `node -e "..."` block with a pointer to `npm run review -- <scenario>` (the derived plan view section covers the same ground).

- [ ] **Step 11.4:** In `CLAUDE.md` § "Debug workflow", add a short paragraph right after "Baseline: `npm test` before and after every non-trivial change":

  > ### Reviewing behavior: `npm run review`
  > 
  > When a scenario failure (or a recording you just regenerated) needs inspection, `npm run review -- <scenario>` prints a structured probe report: purpose, transcript, derived plan view, invariant results, `assertBehavior` results, execution trace summary, and certification status. This is the primary tool for Step 1 of the 5-step verification protocol. `npm run review` (no arg) lists every scenario with its certification status.

- [ ] **Step 11.5:** In `docs/design-docs/004-behavioral-certification-harness.md`, add at the top below the `Status` line:
  
  ```markdown
  > Shipped in: [docs/plans/completed/031-behavioral-certification-harness.md](../plans/completed/031-behavioral-certification-harness.md)
  ```
  
  (Do this only when the plan is moved to `completed/` — add it as part of the Plan completion step, not mid-implementation.)

- [ ] **Step 11.6:** Run `npm test` one final time to confirm the full suite passes with all Phase 1-10 changes in place. Run `npm run review` and visually verify the listing.

- [ ] **Step 11.7:** Commit: `docs: document certification workflow in testing.md and CLAUDE.md`.

---

## Progress

- [x] Phase 1: Assertions context + loader module
- [x] Phase 2: Global invariants module
- [x] Phase 3: BotCore execTrace scaffolding
- [x] Phase 4: Domain helper library
- [x] Phase 5: Migrate scenario 014 to assertions.ts
- [x] Phase 6: Certification stamp format
- [x] Phase 7: Review CLI — suite-level list mode
- [x] Phase 8: Review CLI — scenario-level probe report
- [x] Phase 9: Review CLI — --live flag
- [x] Phase 10: Review CLI — --accept flag
- [x] Phase 11: Documentation updates

---

## Decision log

- **Decision:** `fixture-assertions.ts` is renamed to `assertions.ts` (a single file per scenario) rather than coexisting as two parallel filenames.
  **Rationale:** The design doc § "One scenario-local assertion module" is explicit: "Evolves today's `fixture-assertions.ts` into an `assertions.ts`. Not a second file type alongside the existing one; the same file with a richer export surface." Avoids surface-area sprawl and keeps the "where do my scenario's checks live" question one-answer.
  **Date:** 2026-04-13

- **Decision:** Global invariants are a fixed, runner-enforced list. Not per-scenario, not configurable.
  **Rationale:** Design doc § "Global invariants in the runner". If an invariant is genuinely not global (some scenarios break it legitimately), it is wrong to keep it as an invariant. The initial six (GI-01..GI-06) are conservative enough to pass on today's 62 scenarios; future additions require the same "truly global" bar.
  **Date:** 2026-04-13

- **Decision:** `execTrace` is populated at runtime via a single `onTrace` callback on `BotCoreDeps` — not via AsyncLocalStorage, event emitters, or global singletons.
  **Rationale:** Matches the harness's existing dependency-injection pattern (deps passed explicitly at `createBotCore` call time). Production `grammY` adapter simply does not pass `onTrace`; emission is a no-op. Zero production overhead, zero runtime dependency on harness code, trivial to test. AsyncLocalStorage would require Node version pins and async-context propagation correctness across every handler; callbacks just work.
  **Date:** 2026-04-13

- **Decision:** `execTrace` is NOT persisted to `recorded.json` and NOT compared by `deepStrictEqual`.
  **Rationale:** Design doc § "Execution trace at runtime only". Persisting would lock every handler rename and hook refactor into a scenario failure, creating churn without certification payoff. Load-bearing claims about code paths belong in `assertBehavior` — deterministic code with explicit intent — not byte-equal JSON fields.
  **Date:** 2026-04-13

- **Decision:** Certification hashes are computed over working-tree file bytes (not git HEAD).
  **Rationale:** Design doc § "Certification metadata": "Hashes are computed over the current on-disk files (working tree), not the git-committed HEAD versions." The working tree is what the agent is about to `--accept`; HEAD may lag or be empty during first-time stamping.
  **Date:** 2026-04-13

- **Decision:** `--accept` verifies the scenario (replay + fixture-edit guardrail + global invariants + `assertBehavior` + three `deepStrictEqual` checks) and refuses to stamp if anything fails. It is not a pure stamp.
  **Rationale:** An earlier draft specified `--accept` as a pure stamp on the argument that "certification reflects on-disk state" — meaning the hashes, not the verification outcome. That interpretation is wrong: if the on-disk state doesn't pass `npm test`, stamping it certified creates a false signal that defeats the purpose of the feature. The design doc § "Reviewing one scenario" expects the agent to run the probe report first and decide — but agent discipline alone is the exact failure mode this plan exists to eliminate (per § "Problem": "Under time pressure, a regeneration can slip through without the protocol being fully applied"). Making `--accept` the verification-and-stamp step closes that hole. The agent can still run `npm run review <scenario>` first to inspect the report; `--accept` re-runs the same checks as the last gate before stamping. Verification is sub-second per scenario (replay + assertions, no LLM call), so the cost is negligible.
  **Date:** 2026-04-13

- **Decision:** `completeActivePlans` and `savePlan` are NOT on today's `StateStoreLike` and must not appear in `persist` trace events.
  **Rationale:** An earlier draft of this plan listed those two methods as "known mutation call sites." They were from the pre-Plan 007 interface; the rolling-horizon model (Plan 007) replaced them with `confirmPlanSession` / `confirmPlanSessionReplacing`. Today's `StateStoreLike` (`src/state/store.ts:45`) defines exactly three mutation methods — `confirmPlanSession`, `confirmPlanSessionReplacing`, `logMeasurement` — and the exhaustive table in Step 3.5 lists every call site for those three.
  **Date:** 2026-04-13

- **Decision:** `assertBatchSizesSane` accepts `1 ≤ servings ≤ 3`, not `2 ≤ servings ≤ 3`.
  **Rationale:** Plan 024's proposer explicitly allows 1-serving batches as a last-resort when no multi-serving arrangement fits (`src/agents/plan-proposer.ts:231,241`). `docs/product-specs/testing.md` says "A 1-serving batch is **usually** a bug" — the "usually" matters. A hard `>= 2` rule in the helper would mark valid Plan 024 plans as uncertifiable. Scenarios that want the stricter guard (no 1-serving batches in their specific setup) can assert it themselves in their own `assertBehavior`.
  **Date:** 2026-04-13

- **Decision:** `--live` and `--accept` are mutually exclusive, enforced at argument-parse time.
  **Rationale:** Design doc § "Reviewing one scenario". Ephemeral live behavior must not stamp anything; certification reflects on-disk state. Combining the flags creates the exact bug the design doc is engineered to prevent.
  **Date:** 2026-04-13

- **Decision:** Audit cycle one (migrating the ~60 legacy scenarios) is out of scope for Plan 031.
  **Rationale:** Design doc § "Assertions mandatory for new scenarios; optional for legacy during rollout" + § "Out of scope": "Sequencing of audit cycle one — how many scenarios per session, which classes first, etc. (separate implementation plan)." Plan 031 builds the machinery and proves it via one migration (scenario 014); audit cycle one is Plan 032+.
  **Date:** 2026-04-13

- **Decision:** `TraceEvent` type lives in `src/harness/trace.ts` even though `BotCoreDeps` (production code) imports it.
  **Rationale:** The trace mechanism is a harness concern; production emits events only when given an `onTrace` callback (which only the harness supplies). Moving the type to `src/telemetry/trace.ts` would pretend the mechanism has a production consumer, which it doesn't. The `src/harness/trace.ts` import from production is a single type import — a narrow, deliberate coupling that's easier to audit than a pseudo-neutral module that only the harness actually uses.
  **Date:** 2026-04-13

- **Decision:** Trace emission for validator retries is instrumented at the three inline retry sites (`plan-proposer.ts`, `plan-reproposer.ts`, `recipe-flow.ts`), not on `src/qa/gate.ts`.
  **Rationale:** `qaGate` is currently exported but has zero call sites in `src/`. The real retry loops are inline in the three agents named above. Instrumenting `qaGate` would add no trace coverage; instrumenting the inline sites produces accurate, specific validator names in the trace. The "Generalize the QA-gate-and-retry pattern across all LLM call sites" work is out-of-scope (named in design doc 004); when it lands, the trace hook can move to `qaGate` and the three inline emissions can be removed in the same change.
  **Date:** 2026-04-13

- **Decision:** `certification.json`'s `specHash` field and `recorded.json`'s `specHash` field are different hashes despite the shared name.
  **Rationale:** `recorded.json.specHash` is `hashSpec(spec)` (SHA-256 over canonicalized JSON of input-defining fields; predates this plan, from Plan 006). `certification.json.specHash` is `hashFile(spec.ts)` (SHA-256 over raw file bytes; new in this plan). They answer different questions: the recording's specHash detects "scenario definition drifted, regenerate needed"; the certification's specHash detects "spec.ts file touched at all since certification." Both are legitimate; the name collision is accepted because `certification.json` is self-describing (the three fields are `specHash`, `assertionsHash`, `recordingHash` — all three-files-hashed shape).
  **Date:** 2026-04-13

---

## Validation

End-to-end:

1. `npm test` — every scenario passes three existing `deepStrictEqual` checks, six global invariants, `assertBehavior` (where present), and `assertFixtureEdits` (scenario 014).
2. `npm run review` — lists 62 scenarios. Scenario 014 is `[certified]`. Scenarios 001-013, 015-033, 035-065 are `[uncertified]` (pending audit cycle one).
3. `npm run review -- --needs-review` — lists the 61 uncertified scenarios.
4. `npm run review -- --status certified` — lists only scenario 014.
5. `npm run review -- --status obsolete` — empty listing, summary row correct.
6. `npm run review -- 014-proposer-orphan-fill` — probe report prints purpose, 12+ transcript lines, derived plan view (7×2 grid), all 6 invariants PASS, `assertBehavior` PASS, execTrace summary shows 1 `plan-proposer` retry + 1 `confirmPlanSession` persist op, certification status `[certified]`.
7. `npm run review -- 014-proposer-orphan-fill --live` — real LLM call (requires `OPENAI_API_KEY`). Report prints with LIVE banner. `git status` after exit shows no modified files.
8. `npm run review -- 014-proposer-orphan-fill --accept` — writes `certification.json`. Re-running `npm run review -- 014-proposer-orphan-fill` shows `[certified]`.
9. Touch `test/scenarios/014-proposer-orphan-fill/assertions.ts` (trivial whitespace). Re-run `npm run review` — scenario 014 shows `[needs-review]`. Run `npm run review -- 014-proposer-orphan-fill --accept` — back to `[certified]`. Revert the touch.
10. `npm run review -- 001-plan-week-happy-path --accept` — fails with "Cannot certify: assertions.ts is missing" (design decision 7).
11. `npm run review -- 014-proposer-orphan-fill --live --accept` — fails at parseArgs with "--live and --accept do not combine".
12. Mark scenario 014's stamp `status: obsolete` by hand in `certification.json`. Touch `spec.ts` to shift `specHash`. Run `npm run review` — scenario 014 shows `[obsolete]`, NOT `[needs-review]` (sticky rule). Revert both edits.
13. Introduce a bug: change a telegram reply to `"Something went wrong (test stub)"`. Run `npm test` on any scenario that triggers that reply — expect `GI-02 no-fallback-messages` to fail with the specific output index. Revert the bug.
14. `npm run test:generate -- 014-proposer-orphan-fill --regenerate` followed by `npm run review -- 014-proposer-orphan-fill` — probe report reflects the regenerated recording. Re-apply `fixture-edits.md` + `npm run test:replay -- 014-proposer-orphan-fill`. Report again; `assertFixtureEdits` passes, `assertBehavior` passes.
15. **`--accept` refuses stale recording:** touch scenario 014's `spec.ts` to add a new no-op event (shifting `recorded.specHash`). Run `npm run review -- 014-proposer-orphan-fill --accept` — fails with `Cannot certify: Stale recording: spec hash changed since last generate.` The existing `certification.json` is unchanged on disk (`git status` shows no modifications). Revert the spec touch.
16. **`--accept` refuses failing assertion:** temporarily break scenario 014's `assertBehavior` (e.g., add `throw new Error('artificial');` at the top). Run `npm run review -- 014-proposer-orphan-fill --accept` — fails with the thrown message; no stamp written. Revert.
17. **`--accept` refuses deepStrictEqual drift:** modify a telegram reply string the scenario captures (e.g., change the welcome text in `core.ts`), so live replay diverges from the recorded transcript. Run `npm run review -- 014-proposer-orphan-fill --accept` — fails with `Cannot certify: replay diverges from recording:` and lists which of `outputs` / `finalSession` / `finalStore` diverged. No stamp written. Revert the code change.
18. **`--accept` refuses invariant violation:** temporarily break `GI-04 no-empty-replies` (e.g., add a code path that sends an empty string on one scenario). Regenerate that scenario so the empty reply is locked in. Run `--accept` — fails with the specific invariant. Revert both the code and the regeneration.
19. **`--accept` golden path:** starting from green state, run `npm run review -- 014-proposer-orphan-fill --accept` — stamps successfully; the final "verification: replay ✓ invariants ✓ assertBehavior ✓ deepStrictEqual ✓" line confirms all five verification steps ran.

Regression coverage:

- `test/unit/invariants.test.ts` — all six invariants, positive and negative cases.
- `test/unit/domain-helpers.test.ts` — each of seven planning primitives, positive and negative cases.
- `test/unit/certification.test.ts` — status derivation matrix.
- `test/unit/trace.test.ts` — collector summarize grouping.

No new dependencies. No database changes. No grammY adapter changes. All plan changes compile with `npm run build`.

---

## Feedback
