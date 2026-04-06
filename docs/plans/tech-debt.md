# Tech Debt Tracker

> Scope: Known technical debt and deferred cleanup items. See also: [BACKLOG.md](../BACKLOG.md) for feature roadmap, [plans/active/](./active/) for in-progress work.

## Active items

- **Automated `TestStateStore` ↔ `StateStore` parity test.** Identified: 2026-04-05 during plan 006 (test harness). `TestStateStore` in `src/harness/test-store.ts` mirrors production filter semantics by hand, guarded by cross-reference comments and direct-behavior unit tests. A stronger guarantee would run the same method calls through both implementations and assert identical outputs, but `StateStore` in `src/state/store.ts:29-31` constructs a Supabase client directly in its constructor, so a parity test requires either module-level mocking of `@supabase/supabase-js` or a dependency-injection refactor of `StateStore` to accept a client. Both are out of scope for plan 006. Unlocks: stronger regression guarantee on harness fidelity. Graduates to a plan if test store semantics ever drift from production and cause a harness false-pass.
  Files: `src/state/store.ts:29-31`, `src/harness/test-store.ts`.

- **Scenario-level parallelism in the test harness.** Identified: 2026-04-05 during plan 006. Scenarios run serially in `test/scenarios.test.ts` because `src/harness/clock.ts` monkey-patches `globalThis.Date` process-wide — two scenarios running concurrently would clobber each other's clocks. Current serial execution is fast enough at v0.0.4 scale (sub-second per scenario × a dozen scenarios), but parallelism would cut wall-time as the suite grows. Options: (a) AsyncLocalStorage around Date access, (b) worker-thread sandbox per scenario, (c) per-scenario Date wrapper injected at every call site. None are needed yet. Unlocks: faster test runs when the scenario count grows. Graduates to a plan if the suite ever exceeds ~30s wall-time.
  Files: `src/harness/clock.ts`, `test/scenarios.test.ts`.

- **CI integration for `npm test`.** Identified: 2026-04-05 during plan 006. The harness has clean exit codes and runs offline (no network on replay), so adding a GitHub Actions workflow is a mechanical drop-in. Not done yet because there's no team to gate merges against — prototype stage, single developer. Graduates to a plan when the first collaborator joins or when a merge-blocking check is wanted on PRs.
  Files: `package.json`, `.github/workflows/` (to be created).

- **Proposer sometimes underfills the week (orphan slots).** Identified: 2026-04-06 during Plan 007 scenario 011. The LLM proposer proposed only 4 batches covering Mon-Thu, leaving Sat-Sun with no batch, flex, or event (4 orphan dinner/lunch slots). The QA validator caught it (6.6% calorie deviation, orphan warnings) but the plan was approved anyway. Root cause: the proposer's prompt says "cover all slots" but the LLM doesn't always comply — especially when the recipe set is small and the model is balancing variety rules vs. coverage. Fix options: (a) retry the proposer when orphan slots exist (expensive but robust), (b) add a hard post-proposal check that fills orphans with the best available recipe before presenting to the user, (c) improve the prompt's slot-math emphasis. Graduates to a plan if users hit this in production.
  Files: `src/agents/plan-proposer.ts`, `src/agents/plan-flow.ts`.

- **Scenario 009 calorie deviation (4.3%, isValid=false).** Identified: 2026-04-06 during Plan 007. With 1 pre-committed slot (792 cal) and the remaining budget split across 12 new slots + 1 flex, the per-slot target drops to ~760 cal. Combined with recipe scaling variance, the weekly total lands at 16312 cal vs 17052 target (4.3% deviation). This is a natural consequence of carry-over: frozen macros from session A (792 cal) don't match session B's target (~800 cal), creating a ~50 cal/slot gap across carried days. Not a bug per se — the math is correct — but the tolerance threshold (3%) may need adjusting for horizons with carry-over. Graduates to a plan when tracking/running-budget lands in v0.0.5.
  Files: `src/solver/solver.ts`, `src/qa/validators/plan.ts`.

- **Partial-write cleanup script for confirmPlanSessionReplacing.** Identified: 2026-04-05 during Plan 007 design (D31). If step 3 or 4 of the four-step save-before-destroy sequence fails after steps 1-2 succeed, the old session is partially cleaned up. The failure is self-healing on retry (user taps Plan Week again), but a manual cleanup query should exist for diagnosability. Graduates to a plan if partial writes ever show up in `logs/debug.log`.
  Files: `src/state/store.ts`.

## Resolved

(No resolved items yet.)
