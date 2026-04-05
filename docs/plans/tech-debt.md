# Tech Debt Tracker

> Scope: Known technical debt and deferred cleanup items. See also: [BACKLOG.md](../BACKLOG.md) for feature roadmap, [plans/active/](./active/) for in-progress work.

## Active items

- **Automated `TestStateStore` ↔ `StateStore` parity test.** Identified: 2026-04-05 during plan 006 (test harness). `TestStateStore` in `src/harness/test-store.ts` mirrors production filter semantics by hand, guarded by cross-reference comments and direct-behavior unit tests. A stronger guarantee would run the same method calls through both implementations and assert identical outputs, but `StateStore` in `src/state/store.ts:29-31` constructs a Supabase client directly in its constructor, so a parity test requires either module-level mocking of `@supabase/supabase-js` or a dependency-injection refactor of `StateStore` to accept a client. Both are out of scope for plan 006. Unlocks: stronger regression guarantee on harness fidelity. Graduates to a plan if test store semantics ever drift from production and cause a harness false-pass.
  Files: `src/state/store.ts:29-31`, `src/harness/test-store.ts`.

- **Scenario-level parallelism in the test harness.** Identified: 2026-04-05 during plan 006. Scenarios run serially in `test/scenarios.test.ts` because `src/harness/clock.ts` monkey-patches `globalThis.Date` process-wide — two scenarios running concurrently would clobber each other's clocks. Current serial execution is fast enough at v0.0.4 scale (sub-second per scenario × a dozen scenarios), but parallelism would cut wall-time as the suite grows. Options: (a) AsyncLocalStorage around Date access, (b) worker-thread sandbox per scenario, (c) per-scenario Date wrapper injected at every call site. None are needed yet. Unlocks: faster test runs when the scenario count grows. Graduates to a plan if the suite ever exceeds ~30s wall-time.
  Files: `src/harness/clock.ts`, `test/scenarios.test.ts`.

- **CI integration for `npm test`.** Identified: 2026-04-05 during plan 006. The harness has clean exit codes and runs offline (no network on replay), so adding a GitHub Actions workflow is a mechanical drop-in. Not done yet because there's no team to gate merges against — prototype stage, single developer. Graduates to a plan when the first collaborator joins or when a merge-blocking check is wanted on PRs.
  Files: `package.json`, `.github/workflows/` (to be created).

## Resolved

(No resolved items yet.)
