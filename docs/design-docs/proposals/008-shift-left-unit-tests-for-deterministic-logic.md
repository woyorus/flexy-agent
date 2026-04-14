# Shift-left unit tests for deterministic logic

> Status: draft
> Date: 2026-04-14
> JTBD: Meta / development workflow. Serves every JTBD indirectly by reducing time-to-detect for bugs in the code that powers them.
> PRODUCT_SENSE alignment: "Reliability is existential for a self-use tracker." Catching bugs faster means fewer bugs ever reach the user. This proposal does NOT trade scenario coverage for speed — it adds a faster feedback layer beneath the scenarios so obvious bugs are caught in sub-seconds instead of surfacing during a 20-minute scenario regen.
> Companion: Proposal 007 removes the hand-rolled NLP that was the main driver of slow-loop bugs during Plan 033. This proposal addresses the class of bugs that remain: pure deterministic logic (state machines, data model invariants, store contracts, math) that scenarios catch slowly and indirectly.

## Problem framing — first

**Shipping a bug is infinitely worse than a 2-hour regen cycle.** Scenarios regenerations are CHEAP relative to real user harm. Anything this proposal describes is strictly ADDITIVE to the scenario harness; nothing proposed here replaces or weakens scenario coverage.

The cost we want to reduce is NOT "regens run slower than I'd like." The cost is **time-to-detect** for bugs that the dev loop could catch earlier, for free, if we had the right kind of test. During Plan 033 I found bugs like:

- `buildBatchIngredientSignature` truncated to top-5 by role, hiding distinctive seasonings (a pure-function, 3-line bug).
- `userMentions("ground beef", ...)` returned true when the user's "beef" was inside "beef stock" (pure-function string logic).
- `resolveCandidateBatches` didn't consider swap_history for reversal phrasings (pure-function scan).
- `pendingSwap` lifecycle-cleared on guardrail-reject rewrites, stranding the user's prior preview (state-machine transition).
- Single-candidate `targetIsUnambiguous` was hardcoded to `false`, forcing every ingredient-search-resolved swap into preview (applier orchestration).

Each of these is a pure function of structured inputs. Each would have failed a 5-line unit test in < 50 ms. Instead they surfaced at scenario layer, each triggering a generate-regen cycle of tens of scenarios and minutes of wall time per iteration. Proposal 007 will delete some of this code entirely (the hand-rolled NLP), but the same class of bug will keep emerging in the code that remains — state machines, data-model math, store contracts, orchestration branches — because that code is not going away.

The scenarios did their job. They caught every bug. But they caught them slowly and expensively, in the middle of a regen cascade where a single LLM variance bubbles through 20+ scenarios before I notice. That slowness eats focus and money; it does NOT threaten correctness. The threat is only "slow inner loop."

## Proposed principle

**Every piece of deterministic logic gets a fast-running unit test BEFORE the scenario regen cycle touches it.** Scenarios remain the integration truth; unit tests become the sub-second feedback layer that catches obvious bugs before a single real LLM call fires.

### What counts as "deterministic logic"

- **Pure functions** over structured data: the applier's target resolver, the guardrail validator (whatever of it remains after proposal 007), delta-line formatters, the batch/macro math, the signature builders, the state-machine transition helpers.
- **Store contracts**: `updateBatch` / `updatePlanSessionBreakfast` round-trip, row-mapper symmetry, error shapes on missing-batch / superseded-session.
- **State transitions** on `BotCoreSession`: every `pendingSwap = ...` / `pendingMutation = ...` write, exercised by a minimal handler harness that feeds a fake `SwapResult` / `MutateResult` and asserts the session field after.
- **Data-model invariants** enforced in code: "a fresh batch has no swapHistory", "DraftPlanSession omits breakfastOverride at runtime", "a rename change's `to` field matches the batch's nameOverride after commit".

### What is NOT covered by this proposal

- **LLM-driven logic** — the prompt itself, the agent's decision tree. Those remain scenario-tested; unit-testing an LLM prompt in isolation is fragile and duplicates what the harness already does.
- **End-to-end conversational flow** — scenario harness continues to be the single source of truth for "did the user have a good conversation?".
- **Integration between modules** — anything requiring the real store + real dispatcher + real agent goes through scenarios.

The test for "does this logic get a unit test?" is: **can I call it with structured inputs and assert a structured output, without involving an LLM or a conversation state machine?** If yes, unit-test it. If no, scenario test it.

## The one rule that keeps us honest

> Before authoring or modifying any pure function that a scenario assertion depends on, write (or extend) a unit test for that function's inputs and expected outputs. The scenario is the integration truth; the unit test is the inner-loop truth.

This is NOT "move all scenarios to unit tests." It is: "if a scenario failure ends up blaming a pure function, the next edit to that pure function gets a unit test FIRST." Scenarios keep their role as the behavioral contract; unit tests catch the pure-function regressions in the loop where iteration is free.

## Design decisions

**Unit tests are additive, never subtractive.** Removing or weakening a scenario because its condition is "already unit-tested" is forbidden. A unit test can't see what the user sees; a scenario does. Both run; both hold.

**Unit tests live under `test/unit/`.** The existing `test/unit/` directory already contains a handful of tests (`dispatcher-context.test.ts`, `shopping-generator-scopes.test.ts`). Extend that tree; don't introduce a second location.

**Unit tests are `npm test`'d alongside scenarios.** The runner already picks up `test/**/*.test.ts`. No new infra.

**Test authoring style is table-driven where possible.** A matcher's test file has a single parameterized test case iterating over input/expected pairs. This keeps test maintenance cheap as edge cases accumulate.

**Follow the scenario harness rule: NEVER relax a unit test assertion to make it pass.** If a unit test fails, either the code is wrong or the test's expectation is wrong. In either case, STOP and inspect — same discipline as scenarios (`feedback_scenarios_validate_product.md` auto-memory).

**LLM-dependent code is never unit-tested directly.** Agent decisions, prompt rendering, dispatcher routing — those are integration concerns. A "unit test" that mocks the LLM response just reconstructs what the fixture harness already does, worse.

## Implementation — this proposal authorizes the work

The work is NOT "back-fill every pure function with a unit test." That would be make-work with negative ROI. The proposal authorizes three scoped commitments:

### Commitment A — New code gets unit tests on the same commit

Every new pure function whose output a scenario depends on gets a unit test in the same commit. "On the same commit" is the enforceable standard — no "I'll add tests later", no "it's covered by scenarios." Commit reviewers reject missing unit tests for qualifying new code.

### Commitment B — Scenario regressions produce a unit test

When a bug is caught by a scenario and traced to a pure function, the fix commit MUST include a unit test that fails before the fix and passes after. The scenario stays (it's the user-facing contract); the unit test becomes the fast regression gate. This is how the unit-test library grows organically — from bugs we actually hit, not speculative coverage.

### Commitment C — Mandatory audit of Plan 033's pure-function bug class

To seed the library, the implementation plan runs a one-shot catalog pass on the Plan 033 bugs enumerated above plus the pre-existing pure-function surface in `src/` that scenarios already depend on. The catalog covers:

- `src/plan/swap-applier.ts` pure helpers (after proposal 007's refactor — whatever remains).
- `src/telegram/dispatcher-runner.ts` `buildBatchIngredientSignature`, `buildBreakfastLine`, `summarizePendingSwapForDispatcher`.
- `src/utils/swap-format.ts` (if anything remains after 007).
- `src/state/store.ts` row mapper symmetry + error-path contracts.
- `src/recipes/renderer.ts` `renderCookView` / `renderBreakfastCookView` delta-block rendering (MarkdownV2 output).
- `src/shopping/generator.ts` proration + aggregation math.

Each entry in the catalog gets one of:
- **TEST NOW** — the code is load-bearing and complex enough that unit tests would have measurably reduced Plan 033's inner-loop time.
- **TEST ON NEXT TOUCH** — simpler code; not worth a speculative pass, but the next edit to it MUST bring a test per Commitment A.
- **NOT A UNIT TEST SURFACE** — integration boundary, covered by scenarios only.

The catalog is reviewed by the user before any tests are written.

### Commitment D — Lock the rule in documentation

Like proposal 007, this rule ONLY sticks if it shows up in the first doc a coding agent opens. Required updates:

1. **`CLAUDE.md`** — add a section "Shift-left unit tests for deterministic logic" above the `npm test` baseline section. State the rule, the three commitments, the what-counts/what-doesn't test.
2. **`docs/product-specs/testing.md`** — document the two-tier test layering (unit tests for deterministic pieces, scenarios for integration). Cross-link to this proposal.
3. **`docs/ARCHITECTURE.md`** — add a "Testing layers" subsection that codifies which class of code gets which kind of test.
4. **Auto-memory** — add `feedback_unit_tests_for_deterministic_logic.md` with a one-line checklist: "Before writing a pure function whose output a scenario depends on, write a unit test. Before fixing a bug a scenario caught, write a unit test that would have caught it in the inner loop."
5. **`CLAUDE.md` debug workflow section** — extend the existing "When the user reports an issue" protocol: step 2 currently says "Reproduce the bug as a scenario." Add: "If the bug can be reproduced purely by calling a pure function with structured input — write a unit test FIRST, then the scenario. If only the scenario reproduces it, skip straight to scenario."

No step in Commitment D is optional. The rule binds only if every channel a future agent might look for guidance says so.

## Interaction with the scenario harness

**Scenarios stay exactly as they are.** Test scope isn't reduced. Fixture generation and review continue per `docs/product-specs/testing.md`. Nothing this proposal describes lets an agent say "I'll skip the scenario because there's a unit test" — that is the most important thing this proposal does NOT authorize.

The hoped-for effect of this proposal is that when a scenario fails, diagnosis is faster. A failing scenario + a green unit-test suite narrows the bug to the integration layer (prompt, state machine, store I/O). A failing scenario + failing unit tests on the same pure function tells me exactly where to look. Either way, less time chasing a regression through regen logs.

## Edge cases

**Flaky unit tests.** A table-driven test can surface weird edge cases. Fix the code or narrow the input, never disable. Same rule as scenarios.

**Unit tests for LLM output shape.** Don't — the prompt is the contract for LLM output, and its behavioural check is the scenario. A unit test that asserts an LLM's JSON fields exists is just asserting the fixture file, which `deepStrictEqual` in the scenario already does better.

**New contributors writing scenarios but no unit tests.** The CLAUDE.md + auto-memory entries from Commitment D make this visible. If it keeps happening anyway, add a CI check that fails when a new pure function lands with no corresponding unit test in the same diff — but don't build that until we see it's actually a recurring problem.

**Cost of running the unit tests.** Zero — they add milliseconds to `npm test` at most, and they let `npm test` localize failures faster.

## Out of scope

- Unit tests for LLM prompts (their content, their fixtures, their variance).
- Property-based / generative testing (might be a future follow-up, not needed here).
- Removing any existing scenario.
- Speculative backfilling of tests for code that hasn't surfaced a bug. Commitment C is explicitly a one-shot catalog of the code we already know was hard to debug in Plan 033.
- A second test framework. Use `node:test` as we do today.

## Success criteria

The proposal is successful when:

1. Commitment A is the default — new pure functions committed with tests on the same diff, no retroactive backfill PRs.
2. Commitment B runs on every pure-function-caused scenario failure: a unit test ships in the fix commit.
3. Commitment C's catalog exists, has been reviewed, and the `TEST NOW` entries are done.
4. The rule appears in CLAUDE.md, testing.md, ARCHITECTURE.md, and auto-memory.
5. On the next feature of Plan-033-scope, a coding agent diagnoses a pure-function bug in sub-minute wall time, via a unit-test failure, without ever generating a scenario. If that doesn't happen, the rule hasn't taken — revisit.

If any of these is missed, the proposal has failed even if the code appears to work — because the inner loop will still be scenario-paced and the next plan will replay Plan 033's cost in full.
