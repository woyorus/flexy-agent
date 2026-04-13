# Behavioral Certification Harness

> Status: accepted
> Date: 2026-04-13
> Evolves: design-docs/test-harness-architecture.md (changes framing; preserves layer architecture)
> JTBD: Certify that the product actually works before it ships. The user being the developer, every weekend, running real meals against real money and real time. Serves every user-facing JTBD indirectly — a broken Flexie is not an inconvenience, it is a tracker that lies about macros, fails to plan a livable week, or destroys a saved plan mid-flow.
> PRODUCT_SENSE alignment: Reliability is existential for a self-use tracker. The harness is the agent's only practical way to answer "is this actually safe to run against my week." `npm test` passing must mean something stronger than "the recording matches last time."

## Problem

The scenario harness is doing its first job (replay-determinism) well and its second job (behavioral certification) by agent discipline alone. Those two jobs are not equal. Certification is the one that decides whether the product is safe to ship.

- 66 scenarios exist. Many were authored before today's 5-step verification protocol was as strict as it is now. Some baselines may lock behavior that was never properly inspected.
- `npm test` compares `recorded.json` against live behavior via `deepStrictEqual`. That catches drift. It does not catch a recording that captured wrong behavior on first generation.
- Scenario-specific intent lives in `description` strings and in the agent's head. Nothing in the suite says "scenario 045 passes iff tonight becomes eat-out, the salmon batch is dropped, and persistence takes `confirmPlanSessionReplacing`." Just: "this 800-line JSON blob must replay byte-equal."
- The 5-step verification protocol in `testing.md` is reinforced in CLAUDE.md memory. It is still a soft rule. Under time pressure, a regeneration can slip through without the protocol being fully applied.
- There is no mechanism to distinguish "this scenario's baseline has been behaviorally certified" from "this scenario has a recording that replays." "All green" is not the same as "all certified."

The consequence: a green suite is necessary but not sufficient evidence of correctness. The harness must start treating certification — not replay-determinism — as its center of gravity.

## Thesis

The scenario harness exists to certify product behavior. Every design choice should serve that job.

Three changes follow:

1. **One scenario-local assertion module per scenario**, evolved from today's `fixture-assertions.ts`. Exports `purpose: string`, `assertBehavior(ctx)`, and optionally `assertFixtureEdits(recorded)`. Required for new scenarios; legacy scenarios may omit it until migrated and show up as uncertified.

2. **A small set of global invariants in the runner**, always enforced. Scenario-specific checks live in `assertBehavior`, including domain checks expressed as reusable helpers (`assertPlanningHealthy(ctx)`, `assertNoGhostBatches(ctx)`, `assertSlotCoverage(ctx)`) that scenarios opt into explicitly.

3. **A review command** (`npm run review`) that exposes suite-level certification status and renders per-scenario probe reports. Replay-mode by default; `--live` runs against the real LLM for read-only observation; `--accept` stamps hashes of the current on-disk spec/assertions/recording into a per-scenario certification file. `--live` and `--accept` do not combine.

`deepStrictEqual` stays as the regression net. `recorded.json` gains no new locked fields. Execution trace is available at runtime for assertions and the review report — not persisted, not diffed.

## Current state and what stays

The harness's layer architecture — `BotCore` extraction, `FixtureLLMProvider` with per-hash queuing, `StateStoreLike`, the scenario authoring API, the `node:test` runner, the custom generate CLI — remains accurate and is not revisited here. `design-docs/test-harness-architecture.md` documents that layer design. This proposal changes the *framing* of that doc (replay-determinism is no longer the purpose; it is a supporting property), not the layers themselves.

What changes:

- Today's optional `fixture-assertions.ts` pattern evolves into a scenario-local `assertions.ts` module that exports `purpose`, `assertBehavior`, and optionally `assertFixtureEdits`. Required for new scenarios. Legacy scenarios may omit it; audit cycle one adds it as it visits each.
- A certification stamp file lives next to `recorded.json`. Holds `reviewedAt`, `specHash`, `assertionsHash`, `recordingHash`, and `status: certified | obsolete`. Absence of the file = uncertified. Hash mismatch = needs review (derived). Whether the scenario is fixture-edited is derived from the assertion module's export surface (`typeof assertFixtureEdits === 'function'`), not stored in the stamp.
- Runner runs global invariants plus `assertBehavior(ctx)` (if the module exists) alongside the existing `deepStrictEqual` checks.
- `ScenarioResult` gains a runtime `execTrace` field populated by `BotCore` hooks during the run. Not persisted to `recorded.json`.
- A review command renders per-scenario probe reports and lists suite-level certification status.

The harness is not production code. Changes that simplify the design are preferred over backwards compatibility with the current recording format.

## Proposed experience

### Running the suite

`npm test` — regression replay + global invariants + `assertBehavior` (when present) + existing `deepStrictEqual` checks. Green means the tests pass; it does not imply certification. Uncertified scenarios still pass the suite if their replay and invariants hold.

### Reviewing the suite

`npm run review` with no scenario argument lists every scenario with its certification status. Statuses:

- `certified` — stamp present with `status: certified`; all hashes match the current on-disk spec/assertions/recording.
- `needs-review` — stamp present with `status: certified` but at least one hash differs from the current on-disk file.
- `uncertified` — no stamp file.
- `obsolete` — stamp present with `status: obsolete`. **Sticky**: hash drift does not transition an obsolete scenario to `needs-review`. Obsolete is terminal.

Filters:

- `--needs-review` — scenarios that need agent attention (`uncertified` + `needs-review`). Obsolete scenarios are never included, regardless of hash drift.
- `--status certified` / `--status obsolete` — filter by stored status.

This is the agent's visibility into "what still needs work" and "how is the suite doing overall."

### Reviewing one scenario

`npm run review <scenario>` runs the scenario in replay mode and prints a probe report: purpose, transcript, derived plan view (for planning scenarios), global invariant results, `assertBehavior` results, execution trace summary, and current certification status.

Flags:

- `--live` — use the real OpenAI provider instead of fixture replay. Slow, costs money. **Read-only**: does not touch `recorded.json`, does not touch `certification.json`.
- `--accept` — hashes the current on-disk `spec.ts` / `assertions.ts` / `recorded.json` and writes those hashes to the certification file with `status: certified`. Operates on the working tree, regardless of git commit status. Rejects if `assertions.ts` is missing.

**`--live` and `--accept` do not combine.** Certification always reflects what is on disk right now; ephemeral live behavior does not stamp anything. The workflow for "new behavior expected and then certified" is:

1. Make the change (prompt edit, code fix).
2. *Optional*: `npm run review <scenario> --live` to preview what the live model does before regenerating.
3. `npm run test:generate -- <scenario> --regenerate` to write the new recording to disk (existing command; "delete before regenerate" rule still applies).
4. `npm run review <scenario>` to replay the newly written recording, see the report, verify.
5. `npm run review <scenario> --accept` to certify the current on-disk state.

Each step is a distinct agent decision. Certifying behavior the agent did not replay against the on-disk baseline is the exact failure mode this proposal exists to prevent.

### Authoring a new scenario

Scenario directory contains `spec.ts` + `assertions.ts` + `recorded.json`. `assertions.ts` exports `purpose` and `assertBehavior` (and optionally `assertFixtureEdits`). After generating the recording, running `npm run review <scenario> --accept` creates the initial certification stamp.

A scenario without `assertions.ts` loads and runs (for legacy scenarios mid-migration) but cannot be certified — `--accept` rejects it.

### Fixture-edited scenarios

The product defends against LLM misbehavior by validating every LLM response and re-calling with feedback when validation fails. Fixture-edited scenarios exercise this QA-gate-and-retry pattern: inject a deliberately-bad first fixture, assert the validator caught it, assert the retry happened, assert the second attempt was correct.

Today: scenario 014, with `fixture-edits.md` and `fixture-assertions.ts` exporting `assertFixtureEdits`. The new model preserves this workflow; `assertions.ts` holds `purpose` + `assertBehavior` + the optional `assertFixtureEdits` in a single file. The review tool reports the scenario as fixture-edited based on the presence of `assertFixtureEdits`; no separate flag in the certification stamp.

Generalizing the QA-gate-and-retry pattern across all LLM call sites (dispatcher, recipe generator, re-proposer, etc.) is separate work. This proposal names the pattern and gives it a clear home.

## Design decisions

### 1. One scenario-local assertion module

Evolves today's `fixture-assertions.ts` (optional, scenario 014 only) into an `assertions.ts` that exports `purpose`, `assertBehavior`, and optionally `assertFixtureEdits`. Not a second file type alongside the existing one; the same file with a richer export surface.

Rationale: the agent and harness already know how to work with scenario-local optional assertion modules. Extending that pattern is strictly less surface than introducing a parallel `behavioral-assertions.ts` concept.

### 2. Global invariants in the runner; domain checks as reusable helpers

Global invariants (recording well-formed, no fallback messages, every interactive question has a keyboard, no `undefined`/empty fields, UUIDs normalized) run on every scenario. Not configurable.

Domain checks are helper functions scenarios call from `assertBehavior`:

- `assertPlanningHealthy(ctx)` composes `assertSlotCoverage`, `assertNoGhostBatches`, `assertNoOrphanSlots`, `assertNoDoubleBooking`, `assertBatchSizesSane`, `assertCookDayFirstEating`, `assertWeeklyTotalsAbsorbed`, etc.
- `assertProgressWellFormed(ctx)` for progress scenarios.
- More helpers as the suite grows.

Scenarios opt in explicitly. No classification system. Coverage is visible inside each `assertBehavior` block.

### 3. Execution trace at runtime only

The runner's `ScenarioResult` grows an `execTrace` field: handler sequence, dispatcher decisions, validator retries, persistence paths. Populated by `BotCore` hooks during the run. Not persisted to `recorded.json`, not included in `deepStrictEqual`.

Assertions consume `execTrace` via `ctx.execTrace()`. The review report renders a summary.

Rationale: persisting `execTrace` into `recorded.json` would lock every handler rename and hook refactor into a scenario failure, creating churn without certification payoff. Load-bearing claims about code paths belong in assertions — deterministic code with explicit intent — not in byte-equal JSON fields.

### 4. Certification metadata in a separate file, with orthogonal fields

`certification.json` lives next to `recorded.json`:

```json
{
  "reviewedAt": "2026-04-13T12:34:56Z",
  "specHash":        "sha256:...",
  "assertionsHash":  "sha256:...",
  "recordingHash":   "sha256:...",
  "status": "certified"
}
```

`status` is a stored review outcome: `certified` or `obsolete`. Derived state layers on top: absence of stamp = `uncertified`; stored `certified` + hash match = `certified`; stored `certified` + hash mismatch = `needs-review`. Stored `obsolete` is sticky — it wins regardless of hash state, so an obsolete scenario is never resurrected into the review backlog by drift. Hashes are computed over the current on-disk files (working tree), not the git-committed HEAD versions.

Whether the scenario is fixture-edited is **derived** from the assertion module's export surface (`typeof assertions.assertFixtureEdits === 'function'`), not stored as a field. The assertion module is the single source of truth for scenario shape; the stamp is the single source of truth for review outcome. The two dimensions are orthogonal — a fixture-edited scenario can be certified or obsolete.

Rationale: keeping certification metadata out of `spec.ts` preserves the clean separation between authored input and review state, and sidesteps the self-invalidation problem of hashing a file whose contents include the hash of itself. Splitting scenario-trait from review-outcome keeps the enum honest.

### 5. One review command with orthogonal flags and a suite-level mode

Suite-level: `npm run review` lists scenarios with status, with `--needs-review` and `--status` filters. Scenario-level: `npm run review <scenario>` renders the probe report.

Flag semantics:

- `--live` — use the real LLM. Read-only with respect to disk; no write, no stamp.
- `--accept` — stamp the hashes of the current on-disk spec/assertions/recording into the certification file. Requires `assertions.ts`. Operates on the working tree; git commit status is irrelevant.
- `--live` and `--accept` do not combine.

Writing a new recording happens via the existing `npm run test:generate -- <scenario> --regenerate`. Three separate commands for three separate agent decisions (write new behavior, review on-disk behavior, certify on-disk behavior) — each meaningful, each worth an explicit step.

Rationale: conflating "run live" with "accept" lets the agent certify behavior they did not replay against what is actually on disk. Splitting forces the intended discipline.

### 6. Behavioral assertions are the trust surface; `deepStrictEqual` is the regression net

`deepStrictEqual` catches drift that assertions were not smart enough to notice. It stays in place. The question "is this scenario certifying the right thing?" is answered by reading `purpose` and `assertBehavior`, not by eyeballing JSON.

The harness gains a property it does not have today: a scenario's purpose is executable.

### 7. Assertions mandatory for new scenarios; optional for legacy during rollout

A new scenario must include `assertions.ts` with `purpose` and `assertBehavior` to be certifiable. Legacy scenarios may temporarily omit `assertions.ts`; they load and run via replay + global invariants + `deepStrictEqual`, and show up as uncertified in the review list. Audit cycle one visits each legacy scenario, adds its assertions, and stamps certification.

No stub files. The review tool's listing is the source of truth for "what is still unmigrated." Missing `assertions.ts` is the signal, not a placeholder commit.

### 8. Certification follows on-disk state, not command execution

Running `--live` does not invalidate certification on its own. Only changes to the on-disk files that shift hashes, or an explicit `--accept`, mutate durable state. Exploratory live runs are free.

### 9. Deterministic semantic validation; LLM judgment stays out of the gate

Assertions and invariants are code. No runtime LLM grading. Agent judgment lands at authoring time (write assertions), during audit (decide whether coverage is adequate), and at `--accept` (stamp the current state).

## Edge cases

**Legacy scenarios without assertions.** Replay + global invariants + `deepStrictEqual` run as before. No `assertBehavior`, no stamped certification. Review lists them as uncertified. Audit cycle one migrates.

**Infrastructure land reveals that a legacy scenario violates a newly-enforced global invariant.** That scenario fails `npm test` until fixed. This is expected — the invariant is doing its job surfacing latent bugs. Fix the code, regenerate, re-run.

**Fixture-edited scenarios.** `assertions.ts` exports `assertFixtureEdits` in addition to `purpose` and `assertBehavior`. The review tool reports them as fixture-edited based on that export. `fixture-edits.md` + `test:replay` unchanged.

**Audit surfaces a real bug.** Fix the code → regenerate the scenario → review → `--accept`. Never ratify buggy behavior.

**Live behavior differs from the current on-disk recording.** `--live` is read-only. Agent sees the difference in the report, decides. If the new behavior is correct: regenerate via `test:generate --regenerate` (which overwrites `recorded.json` on disk), review the newly written recording, `--accept`. If broken: fix the code. No automatic path from live observation to certified baseline.

**Obsolete scenarios.** Marked `status: obsolete`. They replay (so future code changes don't break them silently) but are filtered out of `--needs-review`. Preserves history without cluttering the review backlog. Scenarios that are truly irrelevant can still be deleted outright.

**Scenarios whose load-bearing claim is "nothing happened."** Supported. `assertBehavior` can claim absence: `planFlow` stayed `null`, no LLM call was made, no keyboard was shown, no batch was cancelled.

**Weak assertions with a trusted-looking recording.** Safeguarded by agent judgment at review time. No computed coverage metric — measuring what `deepStrictEqual` locks but assertions don't name would need a field-naming model the proposal doesn't define and probably doesn't need.

**Model drift outside the codebase.** `--live` surfaces it. Agent regenerates (if the new live behavior is still good) or fixes the code (if not). Either way, drift does not silently become the new baseline.

**Scenarios where domain checks don't apply.** Navigation scenarios simply don't call `assertPlanningHealthy` from their `assertBehavior`. No opt-out machinery.

## Out of scope

- Exact CLI flag names, file paths, JSON schema details for the new fields.
- The assertion DSL API (`ctx.slot(...)`, `ctx.execTrace()`, etc.) — design detail for the implementation plan.
- Generalizing the QA-gate-and-retry pattern across all LLM call sites (separate work).
- Sequencing of audit cycle one — how many scenarios per session, which classes first, etc. (separate implementation plan).
- Replacing unit tests or lower-level deterministic tests with scenario tests.
- Using an LLM as the final acceptance gate for scenario correctness.
- A ship gate that requires 100% certified coverage — enabled by this model, but not designed here.
