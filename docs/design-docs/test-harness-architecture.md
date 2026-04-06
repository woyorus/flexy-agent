# Test harness architecture

> Status: accepted
> Date: 2026-04-05
> Note: This design doc was written during Plan 006. The `StateStoreLike` interface described here has since been replaced by Plan 007's rolling-horizon model (`confirmPlanSession`, `getRunningPlanSession`, etc.). The harness architecture itself is unchanged — only the persistence surface evolved.

## Problem

The coding agent could not verify its own work on this codebase. Every non-trivial change was a one-shot: write code, `npm run build` passes, hand it to the user, wait for manual Telegram testing to surface bugs. Bugs caused by integration between the state machine, budget solver, mutation handlers, and LLM calls slipped through because none of those layers were individually tested and there was no way to drive the full flow headlessly.

Plan 005 was the canonical example: a `flex_move` silently dissolved a 3-serving batch, the solver over-distributed the weekly budget across the wrong slot count, every lunch got clamped at 1000 cal, and the user only caught it by carefully reading the displayed plan. A unit test on `absorbFreedDay` would not have caught it — the bug lived in the swap tail's failure to surface `recipesToGenerate` before re-running the solver. Only a full-flow test would have caught it.

The harness also had to exist before v0.0.5's significant refactor of plan mutation (fast/slow path, slow-path re-proposer, deletion of `absorbFreedDay` and friends). That refactor will generate 005-class bugs by the handful unless a regression suite exists first.

The critical constraint: the harness itself must be autonomous. A test facility that requires the user to sit down with real Telegram and record every scenario by hand keeps a human in the critical path. The agent must be able to author scenarios as code, generate fixtures once, and replay them fast and free on every iteration.

## Options considered

Three tools were evaluated for the runner:

1. **Vitest** — feature-rich, fast, watch mode, built-in mocking. Rejected because we would use <5% of its features and inherit a large dependency tree (vitest + vite + rollup + ~30 transitive packages) for functionality that already ships with Node 22.
2. **Hand-rolled runner** — maximum control, zero dependencies. Rejected because it would reinvent discovery, name-pattern filtering, and exit-code discipline for no reason when `node:test` provides all three.
3. **`node:test`** (chosen) — built in, zero dependencies, standard idioms any agent or human recognizes. The scenario replay loop is a 1:1 fit for the unit-test model (one assertion per scenario).

For scenario authoring, two approaches were evaluated:

1. **User-recorded scenarios via a Telegram wrapper** — capture real interactions with a `/record save` command and a `dev:record` script. Rejected as the primary path: the harness exists to give the agent a closed loop, and recording keeps a user in the critical path between iterations. Recording is a nice follow-up that can reuse the same dispatch seam and fixture format.
2. **Agent-authored scenarios as TypeScript code** (chosen) — `defineScenario()` returns a typed spec, event helpers (`command`, `text`, `click`, `voice`) make event lists readable, and `npm run test:generate` captures real LLM responses as JSON fixtures committed alongside the spec.

## Decision

Build a five-layer harness:

1. **`BotCore` extraction** — Move all handler logic out of `src/telegram/bot.ts` into `src/telegram/core.ts`, exposing a `dispatch(update, sink)` function that two adapters drive: the grammY adapter (production) and the harness runner (tests). Core produces clean text; the debug footer and `log.telegramIn`/`Out` calls live exclusively in the grammY adapter.

2. **`StateStoreLike` interface** — Added to `src/state/store.ts` alongside the real class, which now declares `implements StateStoreLike`. Production `BotCore` depends on the interface; the harness substitutes an in-memory `TestStateStore`. The interface includes the minimal method set the core actually uses (`getCurrentPlan`, `getLastCompletedPlan`, `getRecentCompletedPlans`, `completeActivePlans`, `savePlan`) — anything unused is excluded to keep the contract small.

3. **`FixtureLLMProvider`** — Implements `LLMProvider` by hash-keyed lookup into a recorded fixture list. SHA-256 hashes canonicalized `{model, reasoning, messages, json, maxTokens}` — every field that affects the OpenAI wire body. `context` is excluded as it's a cost-tracking label. Missing fixtures throw `MissingFixtureError` with the three closest recorded fixtures by Levenshtein distance on the last user message plus the exact regenerate command.

4. **Scenario authoring API** — `defineScenario` is a typed identity function that validates only what types cannot catch (valid ISO clock, non-empty events). Event helpers (`command`, `text`, `click`, `voice`) make spec files read like conversation transcripts. `hashSpec` produces a stable SHA-256 over the input-defining fields (`events`, `initialState`, `recipeSet`, `clock`) for stale-recording detection.

5. **Test runner and generate mode** — Two entry points sharing the wiring internals (`freezeClock`, `TestStateStore`, `RecipeDatabase`, `BotCore`, `CapturingOutputSink`). Replay uses `FixtureLLMProvider` and runs via `node:test` with assertions on `outputs`, `finalSession`, and `finalStore`. Generate wraps the real `OpenAIProvider` in a `RecordingLLMProvider` and writes `recorded.json`. Both normalize UUIDs to `{{uuid:N}}` placeholders before serialization/comparison.

## Why

### Why `BotCore` produces clean text with no debug footer

The current `reply()` helper at `src/telegram/bot.ts` used to call `log.getDebugFooter()`, which reads timing-dependent global state (`operationStart`, `operationEvents` in `src/debug/logger.ts`) and the DEBUG env var. Leaving that call inside core logic would make captured transcripts non-deterministic across runs and force the harness to pin `DEBUG=0`. Moving the append into the grammY adapter is architecturally correct (footer is a view-layer concern) AND delivers three benefits at once: (1) harness transcripts are deterministic regardless of DEBUG mode, (2) core code stops touching a process-global, (3) production debug footers still work for real Telegram users because the grammY adapter appends them as before.

### Why the harness asserts on `finalStore` in addition to outputs

The plan-approval flow calls `store.completeActivePlans()` and `store.savePlan(plan)` as load-bearing side effects. A bug that produces the right Telegram message but skips or corrupts the persistence call would pass a transcript-only check while silently breaking the user's weekly plan. Capturing and asserting on the final store state catches this class of regression directly. This is the exact category of silent failure the harness exists to catch, so every scenario runs three independent `deepStrictEqual` assertions: `outputs`, `finalSession`, and `finalStore`. Implementation-wise this cost one `testStore.snapshot()` call and one extra assertion per scenario — negligible next to the safety it provides.

### Why content-hash matching, not call-order matching

Call-order matching is simpler but brittle: any code change that alters the LLM call sequence silently replays the wrong fixtures. Content-hash matching catches that class of drift with a loud `MissingFixtureError`. The hash covers every field that affects the OpenAI request (`model`, `reasoning`, `messages`, `json`, `maxTokens`), and `context` is excluded because it's a cost-tracking label that never reaches the wire.

### Why fixture responses are queued per hash, not stored by hash alone

Discovered during implementation: LLMs are not byte-deterministic for identical requests. The recipe scaler is routinely called multiple times with the exact same input (same recipe, same target, same servings → identical prompt → identical hash), and the real OpenAI model returns slightly different responses each time. The initial implementation used `Map<hash, fixture>`, which deduplicated by hash, so the second replay call would get the wrong response and `finalStore` diverged.

The fix is a queue per hash: the first call gets the first recorded response, the second gets the second, over-dispatch falls back to the tail. This preserves record-time sequencing without requiring LLM determinism (which is not an API guarantee the harness can rely on). This was not anticipated in the plan and surfaced only when scenario 003 failed on its first replay.

### Why UUID normalization

`uuid.v4()` produces fresh values per run for batch ids, plan ids, and meal slot ids. The uuid package captures a reference to `crypto.randomUUID` at module-load time, which makes monkey-patching the source of randomness after import infeasible without intercepting the module loader. Normalizing UUIDs to `{{uuid:N}}` placeholders post-capture is simpler, makes recorded JSON far more diff-readable, and preserves cross-reference semantics — the same UUID in multiple positions gets the same placeholder, so a bug that swaps references (e.g., `dailyBreakdown` pointing at the wrong batch) still fires on the normalized diff.

### Why scenarios run serially

`src/harness/clock.ts` monkey-patches `globalThis.Date` to freeze time at the scenario's ISO instant. Two scenarios running concurrently would clobber each other's clocks — one scenario's `Date.now()` would return the other's frozen instant, date-dependent prompts would hash wrong, and fixtures would miss. Running scenarios serially in a single `for` loop sidesteps this cleanly and is fast enough at v0.0.4 scale (sub-second per scenario × a dozen scenarios = seconds total).

Moving to parallelism later requires one of: (a) AsyncLocalStorage around `Date` access, (b) per-scenario worker thread sandboxing, or (c) a per-scenario `Date` wrapper injected at every call site. None are needed yet. The `BotCore` extraction already eliminated the other major process-global blocker (`logger.operationEvents`/`operationStart`) by moving the debug footer out of core; the clock is the last remaining obstacle.

### Why `StateStoreLike` lives in `src/state/`, not `src/harness/`

Production runtime code (`BotCore`) depends on the interface. If the interface lived in `src/harness/test-store.ts`, production would import from a test-only module — inverting the dependency direction and setting a precedent that lets test concerns leak into production. The interface is conceptually part of the state layer, so it belongs next to its implementation. The harness imports from production (`import type { StateStoreLike } from '../state/store.js'`), not the other way around. Making the `implements` annotation explicit on `StateStore` turns interface/class drift into a compile-time error rather than a silent runtime divergence.

### Why `defineScenario` does not validate click callbacks

The bot's callback space is not a flat literal list. Handlers use prefix matching for parameterized callbacks: `meal_type_*`, `rv_<slug>`, `rd_<slug>`, `re_<slug>`, `rp_<page>`, `plan_gen_gap_<index>`, `plan_skip_gap_<index>`, `plan_idea_gap_<index>`. A literal-registry check in the harness would reject valid dynamic callbacks like `click('rv_chicken-rice-bowl')`. A smarter check that understood the prefix patterns would duplicate the bot's dispatch logic inside the harness and drift as the bot evolves. The harness's golden-transcript assertion catches typos with high precision and specificity: a wrong callback either produces no handler match (outputs diverge at that step) or the wrong handler's output (outputs diverge at the next step), and `deepStrictEqual` fails loudly with a diff pointing at the bad event. Runtime failure via the assertion model is strictly more accurate than a parallel validation layer, and simpler.

### Why generate mode is a separate CLI, not implicit in `npm test`

Real LLM calls cost money and take time. An "auto-generate on missing" mode would silently burn credits during routine test runs — exactly the bug class the harness should actively prevent. Keeping generate as a separate, explicitly-invoked command (`npm run test:generate -- <name>`) forces conscious action from the agent, which means conscious review of the generated fixtures before committing. The tiny friction of running a second command is a feature, not a cost.

## What actually shipped vs the plan

All nine plan steps landed. Three notable divergences from the plan's pre-execution intent surfaced during implementation:

1. **Fixture queuing per hash** (not anticipated in the plan). Discovered when scenario 003 failed on first replay. The plan assumed one fixture per unique hash; LLM non-determinism required a queue per hash. Documented above and in `src/ai/fixture.ts`.

2. **Error handling moved to grammY adapter** (hinted at but not explicit). The plan implied errors should propagate from core in harness mode but didn't specify the mechanism. Resolution: remove the try/catch from `BotCore.dispatch`; each grammY handler in `src/telegram/bot.ts` wraps its own `dispatch` call with a try/catch that logs and replies "Something went wrong." Harness runners have no wrapper so errors propagate to the test body and fail scenarios loudly.

3. **`setup.ts` loads dotenv before applying dummies** (not in the plan). The plan's original `setup.ts` only assigned dummy values with `??=`, on the assumption that `dotenv` would be loaded elsewhere. In practice the harness entry points don't import `dotenv/config` (the real bot imports it from `src/index.ts`, which the harness never loads). First generate attempt hit OpenAI with the dummy key. Fix: `import 'dotenv/config'` at the top of `setup.ts`, then `??=` fallbacks — real `.env` values still win when present.

The regression proof worked exactly as the plan predicted. Reverting the 005 fix at `src/agents/plan-flow.ts:697-706` causes scenario 002 to fail with `outputs diverged from recorded transcript` — the missing gap prompt surfaces as a direct diff on the captured outputs. Restoring the fix makes the scenario pass again. The harness catches the exact class of bug that motivated it.
