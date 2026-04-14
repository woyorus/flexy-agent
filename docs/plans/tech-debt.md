# Tech Debt Tracker

> Scope: Known technical debt and deferred cleanup items, ranked by severity relative to v0.0.4 production use and the upcoming v0.0.5 milestone. See also: [BACKLOG.md](../BACKLOG.md) for feature roadmap, [plans/active/](./active/) for in-progress work.

## High

- ~~**TD-001: Proposer sometimes underfills the week (orphan slots).**~~ → Resolved, see below.
- **TD-007: Retroactive plan deviations are silently dropped.** Identified: 2026-04-12 during behavioral review of scenario 052 after the post-confirmation past-batch wiring fix. When the user reports a past deviation (*"last night I went to an Indian restaurant"*) the re-proposer's first attempt adds an eat-out event on the past slot; the validator rejects it (#1 event date not in horizon, #9 displaces pre-committed); the retry silently drops the user's event from the proposal and produces unrelated coverage filler ("Added chicken lunch on Sat–Sun"). The user's input never enters the record, but the bot confirms with "Plan updated." Direct PRODUCT_SENSE violation — the system ignores honest user input on the exact real-life moment the product exists to handle. Design proposal: [005-honest-past-logging.md](../design-docs/proposals/005-honest-past-logging.md). Scenario 052's regenerated recording captures the bad behavior and should be regenerated when the proposal lands.
  Files: `src/agents/plan-reproposer.ts`, `src/plan/mutate-plan-applier.ts`, `test/scenarios/052-mutate-plan-retroactive-honest/recorded.json`.

## Medium

- **TD-008: Re-proposer LLM does not always materialize natural-language event adds.** Identified: 2026-04-13 during Plan 032 audit, scenario 023. With the prompt *"Oh wait, I have dinner with friends on Friday, about 900 calories"* the re-proposer responded *"No changes to the plan"* and `mutationHistory` stayed empty. The dispatcher routed correctly (`mutate_plan`); the model simply didn't act. Affects scenario 023's load-bearing claim — certified around the routing path only. Likely fix is on the re-proposer prompt side (clarify event-add intent extraction).
  Files: `src/agents/plan-reproposer.ts`, `test/scenarios/023-reproposer-event-add/recorded.json`.
- **TD-009: Re-proposer recipe-generation handshake does not always terminate in a created recipe.** Identified: 2026-04-13 during Plan 032 audit, scenario 028. The re-proposer surfaces a `recipe_needed` clarification asking *"create Thai green curry, or swap..."*; the user's *"yes"* routes through `clarify` but the model re-asks the same question rather than triggering generation. `mutationHistory` stays at 0. Certified around routing only (see TD-008 for the same pattern). Likely fix is in the affirmative-detection or clarification-resolution branch.
  Files: `src/agents/plan-reproposer.ts`, `src/plan/mutate-plan-applier.ts`, `test/scenarios/028-reproposer-recipe-generation/recorded.json`.

- **TD-003: Partial-write cleanup script for confirmPlanSessionReplacing.** Identified: 2026-04-05 during Plan 007 design (D31). If step 3 or 4 of the four-step save-before-destroy sequence fails after steps 1-2 succeed, the old session is partially cleaned up. The failure is self-healing on retry (user taps Plan Week again), but a manual cleanup query should exist for diagnosability. Graduates to a plan if partial writes ever show up in `logs/debug.log`.
  Files: `src/state/store.ts`.

## Low

- **TD-004: Automated `TestStateStore` ↔ `StateStore` parity test.** Identified: 2026-04-05 during plan 006 (test harness). `TestStateStore` in `src/harness/test-store.ts` mirrors production filter semantics by hand, guarded by cross-reference comments and direct-behavior unit tests. A stronger guarantee would run the same method calls through both implementations and assert identical outputs, but `StateStore` in `src/state/store.ts:29-31` constructs a Supabase client directly in its constructor, so a parity test requires either module-level mocking of `@supabase/supabase-js` or a dependency-injection refactor of `StateStore` to accept a client. Both are out of scope for plan 006. v0.0.5 adds new state (running budget, tracking) which increases the drift surface — good time to tackle it then. Unlocks: stronger regression guarantee on harness fidelity. Graduates to a plan if test store semantics ever drift from production and cause a harness false-pass.
  Files: `src/state/store.ts:29-31`, `src/harness/test-store.ts`.

- **TD-005: CI integration for `npm test`.** Identified: 2026-04-05 during plan 006. The harness has clean exit codes and runs offline (no network on replay), so adding a GitHub Actions workflow is a mechanical drop-in. Not done yet because there's no team to gate merges against — prototype stage, single developer. Graduates to a plan when the first collaborator joins or when a merge-blocking check is wanted on PRs.
  Files: `package.json`, `.github/workflows/` (to be created).

## Negligible

- **TD-006: Scenario-level parallelism in the test harness.** Identified: 2026-04-05 during plan 006. Scenarios run serially in `test/scenarios.test.ts` because `src/harness/clock.ts` monkey-patches `globalThis.Date` process-wide — two scenarios running concurrently would clobber each other's clocks. Current serial execution is fast enough at v0.0.4 scale (sub-second per scenario × a dozen scenarios), but parallelism would cut wall-time as the suite grows. Options: (a) AsyncLocalStorage around Date access, (b) worker-thread sandbox per scenario, (c) per-scenario Date wrapper injected at every call site. None are needed yet. Unlocks: faster test runs when the scenario count grows. Graduates to a plan if the suite ever exceeds ~30s wall-time.
  Files: `src/harness/clock.ts`, `test/scenarios.test.ts`.

## Resolved

- **TD-001: Proposer sometimes underfills the week (orphan slots).** Resolved: 2026-04-06 by Plan 011, then superseded by Plan 024+025. Now handled by `validateProposal()` (13 invariants) + LLM retry loop in both the initial proposer and the re-proposer. `fillOrphanSlots`, `restoreMealSlot`, `computeUnexplainedOrphans`, and `plan-utils.ts` all removed in Plan 025. Regression test: scenario 014 (fixture-edited validator retry).

- **TD-002: Scenario 009 calorie deviation (4.3%, isValid=false).** Resolved: 2026-04-06 by Plan 010 (commit `37a8dfc`). The deviation was not caused by carry-over calorie mismatch as originally hypothesized — the actual root cause was the overflow servings leak in `buildSolverInput`, which passed `b.servings` (including overflow days past the horizon) to the solver, inflating `totalSlots` and diluting `perSlotCal`. Plan 010 fixed this by using `b.days.length`. Scenario 009 now shows 0.006% deviation with `isValid: true`. The ~12 cal/slot carry-over gap is structurally correct and well within the 3% tolerance — no threshold adjustment needed.

## TODO: Audit Plan 033 regen-fix-regen cycle for testing efficiency

During Plan 033 implementation we hit a long cycle of: regenerate → see bug → fix code → regenerate → see another bug → fix → regenerate. Several bugs we found this way (guardrail false positives, dispatcher prompt misclassifications, target-resolution issues, batchLines truncation hiding distinctive ingredients) might have been caught much faster by:

- **Pure-function unit tests** for the guardrail validator (`src/utils/swap-format.ts validateSwapAgainstGuardrails`). Inputs are pure JSON; expected outputs are deterministic. No LLM needed. Would have caught: "beef" matching "beef stock", "extra-firm tofu" rejection, reversal-restore guardrail false positive — all in milliseconds.
- **Pure-function unit tests** for the matcher (`userMentionsLoose` / `userMentionsStrict`) with table-driven cases.
- **Snapshot tests** for the dispatcher prompt builder — when the prompt content changes, fail loudly so the prompt invalidation is visible BEFORE regen burns a wave of LLM calls.
- **Property-based tests** for swap-applier target resolution (given a plan + a user message, what target is resolved? deterministic).

The scenario harness should remain the integration backbone — but the inner-loop bug discovery should happen via these cheap deterministic tests. Estimated saving: 10–20× on time during similar plans.

Owner: pickup whenever the next swap-related work starts.
