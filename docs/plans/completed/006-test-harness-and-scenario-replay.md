# Plan 006: Test harness and scenario replay

**Status:** Completed
**Date:** 2026-04-05
**Completed:** 2026-04-05
**Affects:** `src/telegram/bot.ts` (extract dispatch core, move debug footer out of core logic into the grammY adapter), `src/state/store.ts` (add `StateStoreLike` interface + `implements`), `src/ai/provider.ts` (add fixture implementation), new `src/harness/` directory (runner, loader, clock utility, generate CLI, in-memory test state store), new `test/` directory (scenarios + recipe fixtures + `scenarios.test.ts` entry point + `setup.ts` dummy-env preload), `package.json` scripts (add `test` and `test:generate`).

**Environment coupling note:** `src/config.ts` calls `requireEnv()` for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` at module load time (`src/config.ts:20-52`). Any import chain that transitively touches `config.ts` — including harness code via `plan-flow.ts:26` and `recipe-flow.ts:63` — will throw on module load if those vars are missing. `test/setup.ts` preloads dummy values to satisfy the guard; Step 6 has the details. No production code change is required to `config.ts` itself.

## Problem

The agent (Claude Code) cannot verify its own work on this codebase. Every non-trivial change is a one-shot: write code, `npm run build` passes, hand it to the user, wait for manual Telegram testing to surface bugs. Bugs caused by integration between the state machine, budget solver, mutation handlers, and LLM calls slip through because none of those layers are individually tested and there is no way to drive the full flow headlessly.

Plan 005 is the canonical example: a `flex_move` silently dissolved a 3-serving batch, the solver over-distributed the weekly budget across the wrong slot count, every lunch got clamped at 1000 cal, and the user only caught it by carefully reading the displayed plan. A unit test on `absorbFreedDay` would not have caught it — the bug lived in the swap tail's failure to surface `recipesToGenerate` before re-running the solver. Only a full-flow test would have caught it.

The bigger problem this blocks: v0.0.5 plans a significant refactor of plan mutation (fast/slow path, slow-path re-proposer, deletion of `absorbFreedDay` and friends — see `BACKLOG.md` v0.0.5 entry). That refactor will generate 005-class bugs by the handful unless we have a regression suite in place first. The harness must exist before the refactor.

**Critical constraint: the harness itself must be autonomous.** A test facility that requires the user to sit down with real Telegram and record every scenario by hand keeps a human in the critical path. The agent remains blind between recordings. The goal is to give the agent a closed feedback loop — build feature, author scenarios, run them, observe failures, iterate — without waiting on the user. Scenarios must be authorable by the agent directly, as code, not captured from live Telegram sessions.

The principle the harness enforces: `PRODUCT_SENSE.md` says friction is existential and adherence is the main variable. A planning flow that silently loses meals violates both. "Prototype quality" is not an excuse to ship a tool that breaks user trust on week one of daily use.

## Goal

Give the agent a closed feedback loop: build a feature, author a handful of scenarios covering happy path and edge cases, generate LLM fixtures once, run the suite fast and free on every iteration, fix what's broken, commit when green. The loop must be:

- **Fast** — fixture-replayed LLM calls, no network on normal runs, sub-second per scenario.
- **Deterministic** — same inputs produce same outputs, every run.
- **Agent-authored** — the agent writes scenarios as TypeScript code (initial state, events, recipe set reference). No Telegram session required. A single `--generate` pass calls the real LLM once to capture fixtures, which are then committed and frozen.
- **Real** — scenarios reference curated recipe fixture libraries pulled from real recipes (not toy synthetic data), and can reference multiple fixture libraries to cover variety (minimal, balanced, high-protein, etc.).
- **Standard** — `npm test` runs the suite (via Node's built-in `node:test` runner). `npm test -- --test-name-pattern=<regex>` filters. `npm run test:generate -- <name>` populates missing fixtures via a separate CLI. Exit 0/1 for CI-readiness later.

**Not in scope for plan 006:** User-recorded scenarios from live Telegram. This is a nice-to-have for capturing realistic user sequences the agent wouldn't think to author, but it is not required for autonomy and it adds significant complexity (recording wrappers, `/record save` command, dev:record script, state snapshot serialization). The primary path — agent-authored scenarios — delivers the full feedback loop. Recording can land later as a small follow-up plan that reuses the same dispatch seam and fixture format.

## Architecture

Five layers, building bottom-up.

### Layer 1: Extract a `BotCore` from `src/telegram/bot.ts`

Today `createBot(deps)` returns a grammY `Bot` with handlers, middlewares, and session state (`recipeFlow`, `planFlow`, `recipeListPage`) all closed over inside the factory. The refactor:

- Create `src/telegram/core.ts` exporting `createBotCore(deps)` which returns a `BotCore` object:
  ```typescript
  import type { Keyboard, InlineKeyboard } from 'grammy';

  interface BotCore {
    session: { recipeFlow: RecipeFlowState | null; planFlow: PlanFlowState | null; recipeListPage: number };
    dispatch(update: HarnessUpdate, sink: OutputSink): Promise<void>;
    reset(): void;
  }

  type HarnessUpdate =
    | { type: 'command'; command: string; args?: string }
    | { type: 'text'; text: string }
    | { type: 'callback'; data: string }
    | { type: 'voice'; transcribedText: string };  // voice pre-transcribed; harness skips audio

  interface OutputSink {
    // Handlers keep passing grammY Keyboard / InlineKeyboard instances verbatim,
    // so the structural extraction is zero-churn for every call site.
    // Real adapter sends to Telegram. Capturing adapter serializes for assertions.
    reply(text: string, options?: { reply_markup?: Keyboard | InlineKeyboard }): Promise<void>;
    answerCallback(): Promise<void>;
    startTyping(): () => void;  // returns stop function
  }
  ```
- All existing handler bodies move into a single `dispatch` function that pattern-matches on `update.type` and `update.data`/`update.text`. Every call site that currently does `await reply(ctx, text, { reply_markup: someKeyboard })` becomes `await sink.reply(text, { reply_markup: someKeyboard })` with no change to the keyboard argument.
- `createBot(core)` in `src/telegram/bot.ts` becomes thin: registers grammY handlers that translate `ctx` → `HarnessUpdate` and construct a `grammyOutputSink` (which delegates to `ctx.reply`/`ctx.answerCallbackQuery`), then calls `core.dispatch(update, sink)`.
- **The debug footer moves out of `BotCore` and into `grammyOutputSink`.** Today `src/telegram/bot.ts:92` has a `reply()` helper that appends `log.getDebugFooter()` (which reads timing-dependent global state in `src/debug/logger.ts:211-217`) to outbound text. `BotCore.dispatch` will produce clean text with no footer. `grammyOutputSink.reply` appends the footer right before calling `ctx.reply`, so production behavior is preserved. The harness's `CapturingOutputSink` never calls the footer code, so captured transcripts are deterministic — no timing drift, no DEBUG-mode toggling required. This also removes the logger's process-global `operationEvents`/`operationStart` state from the core code path.
- Voice transcription stays in the grammY adapter. When a voice message arrives: adapter calls `llm.transcribe(buffer)`, then dispatches `{ type: 'voice', transcribedText }`. Harness never sees raw audio.
- Session state is mutated in place on `core.session` — same as today, just hoisted out of the closure so the harness can inspect it before and after dispatch.

**Non-goals for Layer 1:** No change to handler logic beyond moving the debug footer append. No abstraction over storage (`store`), recipes, or LLM. This is a near-verbatim structural extraction — every current handler moves into the dispatch function, keeping the same grammY keyboard objects it always used.

### Layer 2: `StateStoreLike` interface + in-memory `TestStateStore`

**Why:** `BotCore` depends on `StateStore` (Supabase-backed) in `src/telegram/bot.ts:70`, but the harness cannot hit Supabase. More importantly, the flows under test call `store.savePlan`, `store.completeActivePlans`, `store.getCurrentPlan`, etc. (`src/agents/plan-flow.ts:559,562`; `src/telegram/bot.ts:538`) as load-bearing side effects. If we only assert on outputs and in-memory session, a persistence regression (save silently skipped, wrong plan ID, status mismatch) can slip through with a clean-looking transcript. The harness needs to capture and assert on the final state of the store.

**Approach:**

1. **Define `StateStoreLike` in `src/state/store.ts`** (production territory, not `src/harness/`), alongside the concrete class. This is a runtime-neutral type — production `BotCore` depends on it without ever reaching into the harness. The method list is determined by a code audit of every `store.*` call site in `src/telegram/bot.ts`, `src/agents/plan-flow.ts`, and `src/agents/recipe-flow.ts` — not from memory. Signatures are copied verbatim from the real class, including the exact method names that exist today (e.g., `loadSession()`, not `getSession()` — see `src/state/store.ts:157`).

2. **Declare `export class StateStore implements StateStoreLike`** in the same file. Making the `implements` explicit (rather than relying on structural typing alone) gives us a compile-time safety net: if a future change to either the class or the interface drifts, TypeScript fails the build. This is worth the tiny ceremony.

3. Update `BotCore`'s deps type in `src/telegram/core.ts` so `store: StateStoreLike` instead of the concrete `StateStore`. Real `createBot` still passes the real `StateStore` instance; the harness passes a `TestStateStore`. Neither side imports from the other's module.

4. Implement `TestStateStore` in `src/harness/test-store.ts`. It `import type { StateStoreLike } from '../state/store.js'` and `implements StateStoreLike`. Internally stores plans in a `Map<string, WeeklyPlan>` keyed by id and keeps a single session slot. **Semantics must match production exactly.** Specifically: `getCurrentPlan()` returns the most recent plan with `status in ['active', 'planning']` ordered by `weekStart` descending (mirroring `src/state/store.ts:70-82`, which filters with `.in('status', ['active', 'planning'])`). A test store that only tracks `'active'` would diverge on any scenario involving an in-progress plan — a subtle footgun the harness must not introduce. Every query method gets a cross-reference comment pointing at the production line it mirrors, so drift is visible in code review.

5. Expose `snapshot(): { plans: WeeklyPlan[]; currentPlan: WeeklyPlan | null; session: SessionState | null }` for harness assertions. `plans` returns all stored plans regardless of status; `currentPlan` applies the same filter as `getCurrentPlan`; `session` returns the current slot.

6. Constructor accepts optional `{ plans?: WeeklyPlan[]; session?: SessionState | null }` seed data so scenarios can start with pre-existing state (e.g., "user already has an active plan from last week").

**Why the interface lives in production territory:** Production runtime code (`BotCore`) depends on it. If the interface lived in `src/harness/`, production would import from a test module — inverting the healthy dependency direction and creating a precedent that lets test concerns leak into production modules. The interface is conceptually part of the state layer, so it belongs next to the class that implements it.

**Note on the RecipeDatabase:** No changes needed. `src/recipes/database.ts:30` already takes a `recipesDir: string` constructor parameter, and `src/index.ts:33` already passes `config.recipesDir`. Scenarios construct their own `new RecipeDatabase('test/fixtures/recipes/<set-name>')` directly. This was previously Layer 2 in an earlier draft; that step has been removed.

### Layer 3: `FixtureLLMProvider` in `src/ai/`

New file `src/ai/fixture.ts` implementing the existing `LLMProvider` interface (`src/ai/provider.ts:50`).

```typescript
interface LLMFixture {
  hash: string;                // SHA-256 of the canonicalized request
  model: string;
  reasoning?: string;
  json?: boolean;
  maxTokens?: number;
  response: string;
  usage: { inputTokens: number; outputTokens: number };
  callIndex: number;           // metadata for debugging
}

export class FixtureLLMProvider implements LLMProvider {
  constructor(fixtures: LLMFixture[]) { /* ... */ }
  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const hash = hashRequest(options);
    const fixture = this.byHash.get(hash);
    if (!fixture) throw new MissingFixtureError(hash, options, this.closestFixtures(options));
    return { content: fixture.response, usage: fixture.usage };
  }
  async transcribe(): Promise<string> {
    throw new Error('transcribe not supported in fixture mode; pre-transcribe voice events in scenario spec');
  }
}
```

**Request hashing.** `hashRequest(options)` takes the canonical JSON of **every field that affects the LLM's response**: `{ model, reasoning, messages, json, maxTokens }`. `CompletionOptions.context` is deliberately excluded — it's a cost-tracking label (`src/ai/provider.ts:34-35`) and never reaches the wire. SHA-256 over the canonicalized JSON produces a stable key.

The hash **must** include `json` and `maxTokens`: both are part of the actual OpenAI request (`src/ai/openai.ts:79-80`) and either can change the response. Two calls with identical `{model, reasoning, messages}` but different `json: true` vs `json: false` produce structurally different responses (JSON object vs free text); hashing them to the same key would replay the wrong fixture and corrupt the scenario silently.

No normalization of content — the clock is frozen at scenario level so date references are stable. Any meaningful change to the request (prompt, model, reasoning mode, response format, token cap) produces a different hash → `MissingFixtureError` → loud test failure with a diff showing the three closest fixtures by Levenshtein on the last user message. This is the regression signal we want.

**Missing fixture UX.** Error message tells the agent exactly what to do: "Run `npm run test:generate -- <scenario-name> --regenerate` to refresh fixtures for this scenario. If the prompt change is intentional, review the new response before committing."

### Layer 4: Scenario authoring API

New directory: `src/harness/` for runtime infrastructure; `test/scenarios/` for scenario files.

**Scenario directory layout:**

```
test/
├── scenarios/
│   ├── 001-plan-week-happy-path/
│   │   ├── spec.ts           ← agent-authored: inputs and initial state
│   │   └── recorded.json     ← generated by `--generate`: outputs and LLM fixtures
│   ├── 002-plan-week-flex-move-regression/
│   │   ├── spec.ts
│   │   └── recorded.json
│   └── ...
├── fixtures/
│   └── recipes/
│       ├── six-balanced/     ← curated recipe set (full markdown files)
│       │   ├── chicken-bowl.md
│       │   ├── salmon-pasta.md
│       │   └── ...
│       ├── minimal/          ← 2-3 recipes for edge cases
│       └── high-protein/
```

**`spec.ts` shape (agent-authored, small, readable):**

```typescript
// test/scenarios/001-plan-week-happy-path/spec.ts
import { defineScenario, click, text, command } from 'src/harness/define';

export default defineScenario({
  name: '001-plan-week-happy-path',
  description: 'Happy path: 6 balanced recipes, no events, user approves proposal on first try',
  clock: '2026-04-05T10:00:00Z',
  recipeSet: 'six-balanced',
  initialState: {
    // Seed for TestStateStore. Empty = fresh user with no history.
    plans: [],
    session: null,
    // NOTE: `measurements` intentionally omitted — `StateStore` has no measurements API
    // in v0.0.4 (see src/state/store.ts). Add this field to initialState only when the
    // store grows a measurements API.
  },
  events: [
    command('start'),
    // "📋 Plan Week" is a reply-keyboard button (src/telegram/keyboards.ts:33),
    // so it arrives as a text message routed through matchMainMenu at bot.ts:757.
    // NOT a callback — use text(), not click().
    text('📋 Plan Week'),
    // These are inline-keyboard buttons carrying callback data, so click() is correct.
    click('plan_keep_breakfast'),
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
```

Helper functions `command(name, args?)`, `click(data)`, `text(content)`, `voice(transcribedText)` make events readable. `defineScenario` is type-checked and returns the spec for the runner to consume. `recipeSet` is a string key that resolves to `test/fixtures/recipes/<recipeSet>/`.

**Reply keyboards vs inline keyboards — the distinction matters.** The bot uses both. The persistent bottom menu (`mainMenuKeyboard` in `src/telegram/keyboards.ts:33`) is a reply keyboard — tapping a button sends the button's label as a plain text message. The in-flow buttons (breakfast confirmation, plan approval, recipe actions) are inline keyboards — tapping a button dispatches a callback with arbitrary `callback_data`. Scenarios must use `text('<label>')` for the first kind and `click('<callback_data>')` for the second. Getting this wrong means the scenario exercises the wrong code path.

**No authoring-time callback validation.** `defineScenario` is a pure typed identity function — it does not validate that a `click()` callback string matches any real handler. Reason: the bot's callback space is not a flat literal list. Many handlers use prefix matching for parameterized callbacks — `meal_type_<type>`, `rv_<slug>`, `rd_<slug>`, `re_<slug>`, `rp_<page>`, `plan_gen_gap_<index>`, `plan_skip_gap_<index>`, `plan_idea_gap_<index>` (see `src/telegram/bot.ts:165,217,230,246,261,389,411,420`). A literal-registry check would reject valid dynamic callbacks like `click('rv_chicken-rice-bowl')`; a smarter check that understood the prefix patterns would duplicate the bot's dispatch logic in the harness and drift over time. The harness's golden-transcript assertion already catches typos with high precision: a wrong callback either produces no handler match (silent no-op in outputs) or the wrong handler's output, and `deepStrictEqual` fails loudly with a unified diff showing which event produced which unexpected output. Runtime failure via the assertion model is both simpler and strictly more accurate than a parallel validation layer.

**`recorded.json` shape (generated, large, rarely read by hand):**

```json
{
  "generatedAt": "2026-04-05T14:22:11.000Z",
  "specHash": "a1b2c3...",           // hash of the spec that produced this; invalidates on spec change
  "llmFixtures": [
    {
      "hash": "d4e5f6...",
      "callIndex": 1,
      "model": "gpt-5.4-mini",
      "reasoning": "high",
      "response": "{ \"batches\": [ ... ] }",
      "usage": { "inputTokens": 1574, "outputTokens": 11065 }
    }
  ],
  "expected": {
    "outputs": [
      {
        "text": "Welcome to Flexie! Use the menu below to get started.",
        "keyboard": {
          "kind": "reply",
          "buttons": [["📋 Plan Week", "🛒 Shopping List"], ["📖 My Recipes", "📊 Weekly Budget"]],
          "persistent": true,
          "resized": true
        }
      },
      {
        "text": "Planning Mon, Apr 6 – Sun, Apr 12. Breakfast: ...",
        "keyboard": {
          "kind": "inline",
          "buttons": [[
            { "label": "Keep it", "callback": "plan_keep_breakfast" },
            { "label": "Change this week", "callback": "plan_change_breakfast" }
          ]]
        }
      }
      /* ... every TG:OUT message in order ... */
    ],
    "finalSession": {
      "planFlow": { "phase": "confirmed" }
    },
    "finalStore": {
      "plans": [
        { "id": "...", "weekStart": "2026-04-06", "status": "active", "...": "..." }
      ],
      "currentPlan": { "id": "...", "weekStart": "2026-04-06", "status": "active" },
      "session": null
    }
  }
}
```

The `specHash` field detects stale recordings: if `spec.ts` changes (new event, different initial state), the runner notices the hash mismatch on startup and prompts for regeneration.

**Recipe fixture libraries** live in `test/fixtures/recipes/<set-name>/` as real markdown files. A curated set might be a direct copy of the user's current production library at commit time, or a subset designed to stress a specific code path (e.g., `minimal/` has exactly 3 recipes to trigger the "not enough recipes" path in the plan proposer). Scenarios reference sets by name; runner resolves to filesystem path. Git dedupes identical recipe files across sets automatically.

### Layer 5: Test runner and generate mode

New files: `src/harness/runner.ts`, `src/harness/loader.ts`, `src/harness/clock.ts`, `src/harness/generate.ts` (custom CLI), and `test/scenarios.test.ts` (node:test entry point).

**Two entry points, two tools.** Replay mode is a test run → use Node's built-in `node:test` runner. Generate mode is a fixture-writing side-effect operation → use a plain CLI script. Both share `runScenario`, `FixtureLLMProvider`, and the spec/recorded loader.

```
"test":          "tsx --test test/scenarios.test.ts"    ← node:test, for normal runs
"test:generate": "tsx src/harness/generate.ts"          ← custom CLI, for fixture capture
```

**Replay mode (default).** `npm test` or `npm test -- --test-name-pattern=<regex>`:

All scenarios are registered dynamically inside `test/scenarios.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverScenarios, loadScenario, runScenario } from '../src/harness';

const scenarios = await discoverScenarios('test/scenarios');

// Scenarios run SERIALLY because the harness mutates global Date via the clock
// freeze utility. Parallelism is future work gated on eliminating process globals.
for (const dir of scenarios) {
  const { spec, recorded, error } = await loadScenario(dir);

  test(spec.name, async () => {
    if (error) assert.fail(error);  // e.g. "No recording; run `npm run test:generate <name>`"
    const result = await runScenario(spec, recorded);
    assert.deepStrictEqual(result.outputs, recorded.expected.outputs);
    assert.deepStrictEqual(result.finalSession, recorded.expected.finalSession);
    assert.deepStrictEqual(result.finalStore, recorded.expected.finalStore);
  });
}
```

For each scenario, `runScenario(spec, recorded)` internally:
1. Freezes the clock at `spec.clock` (monkey-patch `Date.now`, `new Date()` no-args; restore in `finally`).
2. Constructs `RecipeDatabase` pointing at `test/fixtures/recipes/<spec.recipeSet>/`.
3. Constructs `FixtureLLMProvider` from `recorded.llmFixtures`.
4. Constructs a `TestStateStore` seeded from `spec.initialState` (plans, session). This is an in-memory implementation of `StateStoreLike` that records everything written.
5. Constructs `BotCore` with these deps.
6. Creates a `CapturingOutputSink` that records every `reply()` call. The sink does NOT call `getDebugFooter` (the debug footer was moved into `grammyOutputSink` in Layer 1, so core code produces clean text).
7. Loops: `for each event in spec.events: core.dispatch(event, sink)`.
8. Returns `{ outputs: sink.captured, finalSession: core.session, finalStore: testStore.snapshot() }`.

**Why assert on `finalStore` in addition to outputs:** The plan-approval flow calls `store.completeActivePlans()` and `store.savePlan(plan)` as load-bearing side effects (`src/agents/plan-flow.ts:559,562`). A bug that produces the right Telegram message but skips or corrupts the persistence call would pass a transcript-only check while silently breaking the user's weekly plan. Capturing and asserting on the final store state catches this class of regression directly. This is the exact category of silent failure the harness exists to catch.

`loadScenario(dir)` handles the "no recording" and "stale recording" cases by returning an `error` string instead of a `recorded` object; the test body then calls `assert.fail(error)` which surfaces as a normal test failure with a readable message.

**Why node:test and not a custom runner:** node:test gives us discovery, name-pattern filtering, pretty reporter, exit code discipline, and watch mode (`node --test --watch`) for free, zero dependencies, and with standard idioms that any agent or human recognizes. The replay loop is a 1:1 fit for the unit-test model (one assertion per scenario), so there's nothing to gain from reinventing. Note that we do not use node:test's parallelism — scenarios run serially because the clock-freeze utility is process-global. See the "serial execution" decision in the Decision Log.

**Custom diff fallback.** `assert.deepStrictEqual` on arrays of `{text, keyboard}` message objects produces adequate but not always pretty diffs. If output in practice turns out too noisy, `runScenario` catches the comparison mismatch internally, formats a nicer unified diff, and throws a fresh `AssertionError` with that message. This is a fallback — start with the default, replace only if needed.

**Generate mode.** `npm run test:generate -- <name>`:

A separate CLI at `src/harness/generate.ts`, not wrapped in node:test because it is not a test:

1. Parse args: `<name>`, `--regenerate`, `--yes`.
2. Load `test/scenarios/<name>/spec.ts`.
3. If `recorded.json` exists and `--regenerate` not set → error "Already has a recording. Use `--regenerate` to overwrite." Exit 1.
4. Print warning: "Generating fixtures for <name> — this will call the real LLM and may cost money. Continue? (Ctrl-C to abort, any key to proceed)" Wait for keystroke. Skip waiting if `--yes`.
5. Construct `RecipeDatabase` rooted at the fixture set, real `OpenAIProvider` wrapped in `RecordingLLMProvider`, `TestStateStore` seeded from `spec.initialState`, frozen clock.
6. Construct `BotCore` with these deps and a `CapturingOutputSink`.
7. Loop events, calling dispatch for each.
8. Serialize captured outputs, final session, **final store snapshot (`testStore.snapshot()`)**, LLM fixtures, and spec hash to `recorded.json`. Generate mode and replay mode must capture the same fields in the same shape; otherwise replay fails on the first run with a phantom diff.
9. Print summary including total LLM cost and call count.
10. Agent reviews `recorded.json` via `git diff`, confirms outputs look correct, commits.

**Key constraints:**
- Generate mode is never triggered by `npm test`. Missing fixtures fail the test with instructions to run `npm run test:generate`.
- `--regenerate` is required to overwrite existing fixtures. No silent overwrites.
- Both entry points exit 0/1 cleanly for CI-readiness later.

**Clock freeze.** Utility at `src/harness/clock.ts`. Monkey-patches `Date.now` and the `Date` constructor (with zero args). Restores on cleanup. Does not touch `setTimeout`/`setInterval` — those are not date-based and we want them to work normally so the bot's internal async flow proceeds.

## Plan of work

Work proceeds in dependency order. Each step ends with `npm run build` passing and, where applicable, a working test on a trivial scenario.

### Step 1 — `BotCore` extraction

File: `src/telegram/bot.ts` → `src/telegram/core.ts` (new) + `src/telegram/bot.ts` (shrunk).

1. Define `HarnessUpdate`, `OutputSink`, `BotCore` types in `src/telegram/core.ts`. `OutputSink.reply` takes `{ reply_markup?: Keyboard | InlineKeyboard }` from grammY — handlers pass their existing keyboard objects verbatim.
2. Move every handler body from `bot.ts` (`bot.command('start')`, `bot.command('cancel')`, `bot.on('callback_query:data')` at line 158, `bot.on('message:voice')` at line 466, `bot.on('message:text')` at line 485) into a single `dispatch(update, sink)` function inside `createBotCore`. The session variables (`recipeFlow`, `planFlow`, `recipeListPage`) become fields on `core.session`.
3. **Move the debug footer out of core into the grammY adapter.** The current `reply()` helper at `bot.ts:92` calls `log.getDebugFooter()` and appends timing-dependent state to outbound text. In the new structure: `BotCore.dispatch` produces clean text via `sink.reply`. The grammY adapter's sink implementation (`grammyOutputSink`) is the ONLY place that calls `getDebugFooter()` and appends the footer before forwarding to `ctx.reply`. Harness sinks never touch the footer, so captured transcripts are deterministic regardless of DEBUG mode.
4. Rewrite `createBot(deps)` in `bot.ts` to: call `createBotCore(deps)`, register thin grammY handlers that translate `ctx` into a `HarnessUpdate` and construct a `grammyOutputSink`, then call `core.dispatch(update, sink)`.
5. Keep voice transcription in the grammY adapter. Audio buffer → `llm.transcribe()` → dispatch `{ type: 'voice', transcribedText }`.
6. Verify by running `npm run dev` against real Telegram, with `DEBUG=1` to confirm the footer still appears in production. Every flow should behave identically to before, including the footer in debug mode.

**Acceptance:** All existing Telegram flows work unchanged. `bot.ts` is ~100 lines of grammY wiring. Logic lives in `core.ts`.

> **Note on Telegram verification.** This manual check is a **one-time structural-migration gate**, not an ongoing requirement. Once Step 1 lands and this check passes, the harness takes over — all subsequent scenario validation is fully automated through `npm test`, with no further Telegram interaction required. This single exception to the autonomy principle exists because the only thing that can prove grammY integration still works end-to-end is a real Telegram round-trip; the harness does not (and should not) simulate grammY itself.

### Step 2 — `StateStoreLike` interface + `TestStateStore`

Updates: `src/state/store.ts` (add interface, add `implements` to class), `src/telegram/core.ts` (use interface in BotDeps). New file: `src/harness/test-store.ts`.

1. **Audit every `store.*` call site** across `src/telegram/bot.ts`, `src/agents/plan-flow.ts`, `src/agents/recipe-flow.ts`, and any other caller. Record the full set of methods actually used. Do not rely on memory — grep for `store\.` and enumerate.
2. Add `export interface StateStoreLike { ... }` to `src/state/store.ts` with exactly those method signatures copied from the class. Include `loadSession` (not `getSession` — verify the real method name).
3. Add `implements StateStoreLike` to the `export class StateStore` declaration in the same file. TypeScript then catches any future drift between class and interface at compile time.
4. Update `BotDeps` in `src/telegram/core.ts`: `store: StateStoreLike` (was `store: StateStore`). Production `createBot` keeps passing the real class instance — it satisfies the interface via `implements`.
5. Create `src/harness/test-store.ts`. `import type { StateStoreLike } from '../state/store.js'`. `export class TestStateStore implements StateStoreLike { ... }`. For every query method, **mirror production semantics exactly**. Specifically:
   - `getCurrentPlan()` filters `plans` by `status in ['active', 'planning']`, sorts by `weekStart` descending, returns the first. Cross-reference comment: `// mirrors src/state/store.ts:70-82`.
   - `getLastCompletedPlan()`, `getRecentCompletedPlans()`, and any other filtering method get the same treatment: comment pointing at the production line, semantics copied verbatim.
   - Mutation methods (`savePlan`, `completeActivePlans`, `saveSession`) record writes into internal `Map`s and update derived state (e.g., `completeActivePlans` flips every `status: 'active'` plan to `'completed'`).
6. Constructor accepts optional `{ plans?: WeeklyPlan[]; session?: SessionState | null }` for seed data.
7. Expose `snapshot(): { plans: WeeklyPlan[]; currentPlan: WeeklyPlan | null; session: SessionState | null }` for harness assertions. `currentPlan` applies the same filter as `getCurrentPlan()`.
8. **Unit tests on `TestStateStore` query semantics** (not a parity test against the real class). Seed with known plans, call each query method, assert the result matches what the production filter specification demands. Example cases:
   - Seed `[activePlan(weekStart='2026-03-30'), planningPlan(weekStart='2026-04-06')]`. `getCurrentPlan()` must return the planning plan (more recent `weekStart`, both statuses are in the filter).
   - Seed `[completedPlan, completedPlan, activePlan]`. `getCurrentPlan()` must return the active plan.
   - Seed three completed plans with decreasing `weekStart`. `getRecentCompletedPlans(2)` must return the two most recent.
   - `completeActivePlans()` on a store with two active plans must leave both with `status: 'completed'`.
   - Every filter-method test gets a comment citing the production line its expected behavior is derived from.

   These tests verify **behavior correctness**, not **parity against the real class**. A true parity test (run the same calls through `TestStateStore` and a mocked `StateStore`, assert identical outputs) would require either mocking `@supabase/supabase-js` at module level or refactoring `StateStore` to accept a client via DI (`src/state/store.ts:29-31` currently constructs the client itself). Both are out of scope for plan 006. A tech-debt item records the gap (see `plans/tech-debt.md` update).

**Acceptance:** A standalone test script constructs `new TestStateStore({ plans: [activePlan, planningPlan] })`, calls `getCurrentPlan()`, and receives the planning plan (because it has the more recent `weekStart`) — proving the `['active', 'planning']` filter works. Production `npm run dev` continues unchanged. Unit tests on `TestStateStore` query semantics pass.

**Note:** `RecipeDatabase` requires no changes — it already accepts a `recipesDir` constructor parameter (`src/recipes/database.ts:30`). Scenarios construct `new RecipeDatabase('test/fixtures/recipes/<set-name>')` directly.

### Step 3 — `FixtureLLMProvider`

New file: `src/ai/fixture.ts`.

1. Implement `hashRequest(options: CompletionOptions): string` — canonical JSON of `{ model, reasoning, messages, json, maxTokens }`, SHA-256. Every field that affects the actual OpenAI request (`src/ai/openai.ts:79-80`) must be in the hash. `context` is deliberately excluded (cost-tracking label only, doesn't reach the wire).
2. Implement `FixtureLLMProvider` class backed by a `Map<hash, LLMFixture>`.
3. Implement `MissingFixtureError` with diagnostic output: failing hash, full failing request (including `json` and `maxTokens`), three closest fixtures by Levenshtein distance on the last user message, and the exact command to re-generate.
4. Unit tests: (a) construct with two fixtures, call `complete` twice, verify correct responses; (b) call with a missing prompt, verify `MissingFixtureError` with expected diagnostic shape; (c) **call with identical messages but different `json` values, verify different hashes and no collision**; (d) same for `maxTokens`.

**Acceptance:** Unit tests pass, including the `json`/`maxTokens` collision cases. `FixtureLLMProvider` drops into `createBotCore` in place of `OpenAIProvider`.

### Step 4 — Scenario authoring API

New files: `src/harness/define.ts`, `src/harness/types.ts`.

1. Define `Scenario`, `ScenarioEvent`, `RecordedScenario` types in `src/harness/types.ts`.
2. Implement `defineScenario(spec): Scenario` in `src/harness/define.ts` — pure typed identity function. Validates only what types can't catch: `recipeSet` resolves to a real directory under `test/fixtures/recipes/`, `clock` parses as a valid ISO timestamp, `events` array is non-empty. **No callback-data validation** — see Layer 4 rationale (dynamic prefix-matched callbacks make a registry check either too narrow or a parallel dispatch implementation that drifts). Typos in `click('...')` callbacks surface loudly at runtime via transcript diff.
3. Export event helpers: `command(name, args?)`, `click(data)`, `text(content)`, `voice(transcribedText)`. Each is a one-liner returning a tagged event object. No validation beyond type narrowing.
4. Implement `hashSpec(scenario): string` — stable hash of the input-defining fields (`events`, `initialState`, `recipeSet`, `clock`). Used for stale-recording detection.

**Acceptance:** A `test/scenarios/sample/spec.ts` using `defineScenario` + helpers type-checks and can be imported by a standalone Node script. An invalid `recipeSet` (unknown directory) fails at load time with a clear error; an invalid `click('...')` callback does NOT fail at load time — it surfaces via transcript diff during the test run.

### Step 5 — Recipe fixture libraries

New directory: `test/fixtures/recipes/`.

1. Create `test/fixtures/recipes/six-balanced/` by copying the user's current production recipe library (`recipes/*.md` at plan-006 commit time). This becomes the realistic baseline for happy-path scenarios.
2. Create `test/fixtures/recipes/minimal/` with 3 recipes hand-picked to stress edge cases (exactly enough or not enough to cover a week's slots).
3. Commit both. Document in `test/fixtures/recipes/README.md`: what each set is for, how to add a new one.

**Acceptance:** Both directories exist with real recipe markdown files. A scenario referencing `recipeSet: 'six-balanced'` or `recipeSet: 'minimal'` resolves correctly.

### Step 6 — Test runner (replay mode via `node:test`)

New files: `src/harness/runner.ts`, `src/harness/loader.ts`, `src/harness/clock.ts`, `src/harness/capturing-sink.ts`, `test/scenarios.test.ts`, `test/setup.ts`.

1. Implement `src/harness/clock.ts` — freeze/restore `Date.now` and the zero-arg `Date` constructor. Documented as process-global, not re-entrant; scenarios must run serially.
2. Implement `src/harness/loader.ts` exporting `discoverScenarios(dir)` (returns scenario directory list) and `loadScenario(dir)` (returns `{ spec, recorded, error }`, where `error` is a string when `recorded.json` is missing or has a stale `specHash`).
3. Implement `src/harness/capturing-sink.ts` — `CapturingOutputSink` that satisfies `OutputSink`, captures `{ text, keyboard }` per reply, and serializes grammY `Keyboard` / `InlineKeyboard` instances into the tagged `CapturedKeyboard` shape (`{ kind: 'reply', ... }` or `{ kind: 'inline', ... }`). Does NOT call `getDebugFooter` — the footer lives in `grammyOutputSink` only.
4. **Implement `test/setup.ts` — dummy-env preload.** `src/config.ts` calls `requireEnv()` for five vars at module load (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`). The harness's import chain transitively touches `config.ts` via `plan-flow.ts:26` and `recipe-flow.ts:63`, so without preload the test runner dies on import. `test/setup.ts` assigns obvious dummy values with `??=` so a real `.env` still takes precedence:

    ```typescript
    // test/setup.ts
    // Preloaded by `node --import ./test/setup.ts` before scenarios.test.ts loads any
    // harness code. Satisfies src/config.ts:20-52 requireEnv guards so the module
    // loads without a real .env file. These values are never used for real I/O:
    // TestStateStore replaces StateStore (no Supabase calls), FixtureLLMProvider
    // replaces OpenAIProvider (no OpenAI calls), and BotCore is driven directly
    // without grammY (no Telegram calls). The Supabase SDK does not validate URL
    // or key at createClient() time, only on first query — which never happens
    // in harness mode.
    process.env.TELEGRAM_BOT_TOKEN ??= 'harness-dummy-no-network';
    process.env.TELEGRAM_CHAT_ID ??= '0';
    process.env.OPENAI_API_KEY ??= 'harness-dummy-no-network';
    process.env.SUPABASE_URL ??= 'https://harness-dummy.invalid';
    process.env.SUPABASE_ANON_KEY ??= 'harness-dummy-no-network';
    ```

5. Implement `runScenario(spec, recorded): Promise<ScenarioResult>` in `runner.ts`:
   - Freeze clock at `spec.clock`.
   - Build `RecipeDatabase` rooted at `test/fixtures/recipes/<spec.recipeSet>/`.
   - Build `FixtureLLMProvider` from `recorded.llmFixtures`.
   - Build `TestStateStore` seeded from `spec.initialState`.
   - Build `BotCore` with `{ llm, recipes, store }` deps and a `CapturingOutputSink`.
   - Loop `spec.events`, calling `core.dispatch(event, sink)` for each.
   - Return `{ outputs: sink.captured, finalSession: core.session, finalStore: store.snapshot() }`.
   - Restore clock in `finally`.
6. Implement `test/scenarios.test.ts` — awaits `discoverScenarios`, registers one `test(spec.name, async () => { ... })` per scenario in a **serial for-loop** (not `.concurrent`), asserts `deepStrictEqual` on **all three**: outputs, final session, AND final store. If `loadScenario` returned an `error`, the test body calls `assert.fail(error)`.
7. Add `"test": "tsx --test --import ./test/setup.ts test/scenarios.test.ts"` to `package.json`. The `--import` flag loads `test/setup.ts` before any test file, guaranteeing env vars are set before `config.ts` is transitively imported. Same flag is added to `test:generate` in Step 7.

**Acceptance:** `npm test` runs via `node:test` on a fresh clone with **no `.env` file present** — no env-var errors at import time because `test/setup.ts` provides dummy values first. With no scenarios, prints "0 passed". With a scenario but no `recorded.json`, the test fails cleanly with "No recording; run `npm run test:generate <name>`" as the failure message. `npm test -- --test-name-pattern=<regex>` filters by scenario name. A scenario that produces the expected Telegram transcript but skips a `store.savePlan` call (synthetic bug injection test) fails on the `finalStore` assertion — proving the persistence-regression safety net works. **A live network check confirms the harness makes zero outbound HTTP calls during a full suite run** (run with a network sniffer or just verify no errors when offline).

### Step 7 — Generate mode (custom CLI)

New file: `src/harness/generate.ts`. Reuses `runScenario`'s internals but with real LLM instead of fixtures.

1. Implement `generateScenario(specDir, options): Promise<void>`: loads `spec.ts`, refuses to overwrite existing `recorded.json` without `--regenerate`, prompts for keystroke unless `--yes`, builds deps with real `OpenAIProvider` wrapped in a `RecordingLLMProvider`, runs the event loop, writes `recorded.json` with captured outputs + LLM fixtures + spec hash + timestamp.
2. Implement `generate.ts` as an executable entry point: parses `<name>`, `--regenerate`, `--yes` from argv; calls `generateScenario`; prints LLM usage summary (token counts, cost per provider) after each scenario.
3. Add `"test:generate": "tsx --import ./test/setup.ts src/harness/generate.ts"` to `package.json`. The `--import ./test/setup.ts` is required even in generate mode because generate still transitively imports `config.ts` via `plan-flow.ts`, and the real `OPENAI_API_KEY` must be sourced from a real `.env` if present — `test/setup.ts`'s `??=` leaves real values untouched. Invocation: `npm run test:generate -- <scenario-name>`.

**Acceptance:** `npm run test:generate -- <name>` on a scenario with no recording creates a valid `recorded.json`, prints cost, and the next `npm test` on that scenario passes via fixture replay. Attempting to regenerate an existing recording without `--regenerate` refuses cleanly. Generate mode requires a real `OPENAI_API_KEY` in the environment; if missing, the failure is a clear OpenAI auth error, not an env-var exception at import time (setup.ts fills in a dummy, OpenAI SDK rejects it on first call).

### Step 8 — First scenarios

Three agent-authored scenarios to ship with the harness:

1. **`001-plan-week-happy-path`** — six-balanced recipes, no events, keep breakfast, approve proposal. Event sequence: `command('start')`, `text('📋 Plan Week')` (reply-keyboard button, not a callback), `click('plan_keep_breakfast')`, `click('plan_no_events')`, `click('plan_approve')`. Validates the core planning flow end-to-end and exercises the reply-keyboard → text-message dispatch path alongside the inline-keyboard callback path.
2. **`002-plan-week-flex-move-regression`** — the full plan-005 repro. Six-balanced recipes, a fresh user, the exact flex_move sequence from `logs/debug.log`. Event order is **load-bearing** — the swap flow requires `plan_swap` to transition to `awaiting_swap` phase (`src/agents/plan-flow.ts:576`) *before* it will accept free-text input. Sending text first while phase is `proposal` (not `awaiting_swap`) makes the bot silently drop it at the text-handler guard (`src/telegram/bot.ts:665`):

    ```typescript
    events: [
      command('start'),
      text('📋 Plan Week'),
      click('plan_keep_breakfast'),
      click('plan_no_events'),
      // Proposal arrives with Moroccan beef Fri-Sun dinner batch and Thu flex.
      click('plan_swap'),                     // transitions to awaiting_swap; bot prompts "What would you like to change?"
      text('Move flex slot to Saturday'),     // nano classifier → flex_move Thu → Sat
      // Moroccan beef Fri-Sun batch dissolves (Sat gets flex, Fri+Sun orphaned,
      // neighbor batches at 3-serving max so absorbFreedDay can't re-home them).
      // Plan-005 fix: three gap prompts presented one at a time. `activeGapIndex`
      // is incremented by `advanceGapOrPresent` (src/agents/plan-flow.ts:815-818)
      // after each skip, and the re-rendered keyboard bakes the new index into
      // the callback string (src/telegram/bot.ts:425-426 → keyboards.ts:210-212),
      // so the callbacks are numbered 0, 1, 2 — NOT three identical _0 calls.
      click('plan_skip_gap_0'),               // Thu dinner gap
      click('plan_skip_gap_1'),               // Fri dinner gap
      click('plan_skip_gap_2'),               // Sun dinner gap
      // All gaps resolved, solver re-runs over 7 batches, final proposal displayed.
      click('plan_approve'),
    ],
    ```

    **Regression lock shape.** The golden transcript MUST contain three consecutive `planRecipeGapKeyboard` messages between the swap and the final proposal — one per orphaned day (Thu, Fri, Sun). If the plan-005 fix at `src/agents/plan-flow.ts:697-706` regresses, `recipesToGenerate` stops being surfaced, the three gap prompts disappear from the transcript, and the solver silently redistributes the weekly budget over 10 slots instead of 13 — producing per-slot calorie values clamped at 1000 (the exact failure mode from `logs/debug.log`). Both of those symptoms are caught by `deepStrictEqual` on the outputs list.

    **`finalStore` assertion.** After `plan_approve`, `testStore.snapshot().plans` must contain a single plan with `status: 'active'` and **7 batches** (4 surviving original batches + 3 resolved via gap prompts). If the persistence regression class (plan saved in wrong state, skipped entirely, or saved with the pre-fix 10-slot batch count) appears, this assertion fires independently of the transcript.

    **Why both assertions matter.** A future bug could produce a correct-looking transcript but a wrong persisted plan, or a wrong transcript with a correct persist — asserting on both closes both gaps.

    > **Note on gap callback indices.** The callbacks are `plan_skip_gap_0`, `plan_skip_gap_1`, `plan_skip_gap_2` (not three identical `_0` calls). The index increments because `advanceGapOrPresent` in `src/agents/plan-flow.ts:815-818` does `state.activeGapIndex = nextIndex` after each skip, and the post-skip keyboard re-render in `src/telegram/bot.ts:425-426` reads the updated index via `planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)` — which bakes the new index into the callback strings per `src/telegram/keyboards.ts:210-212`. If a future refactor changes this contract (e.g. stable-per-gap keys like `plan_skip_gap_thu`), `specHash` mismatch + regenerate catches the drift.
3. **`003-plan-week-minimal-recipes`** — minimal recipe set (3 recipes), no events, full flow. Exercises the "not enough recipes, must generate" path in the proposer.

For each:
1. Author `spec.ts`.
2. Run `npm run test:generate -- <name>` to create `recorded.json`.
3. Manually inspect the `expected.outputs` and `llmFixtures` for sanity.
4. Commit `spec.ts` + `recorded.json` + any new recipe fixtures.
5. Run `npm test` — all three must pass.
6. **Regression proof for scenario 002:** temporarily revert the gap-surfacing conditional at `src/agents/plan-flow.ts:697-706` (the 005 fix: the `if (state.proposal.recipesToGenerate.length > 0)` block that sets `pendingGaps` and returns `presentRecipeGap`). Re-run `npm test -- --test-name-pattern=002-plan-week-flex-move-regression`. Expected failure shape: the three consecutive gap-prompt messages disappear from the captured outputs and the solver re-renders the proposal directly with 10 slots and "1022 cal clamped" warnings — both caught by the outputs `deepStrictEqual`. The `finalStore` assertion also fires because the approved plan's batch count is wrong. Restore the fix. Re-run. Pass.

**Acceptance:** Three scenarios committed. All pass under `npm test`. Scenario 002 demonstrably fails when the 005 fix is reverted — with the failure visible in BOTH the outputs diff (missing gap prompts) and the finalStore diff (wrong batch count on the persisted plan).

### Step 9 — Documentation + design doc promotion

Files: new `docs/product-specs/testing.md`, new `test/README.md`, new `docs/design-docs/test-harness-architecture.md`, updates to `CLAUDE.md`, `docs/product-specs/index.md`, `docs/design-docs/index.md`, and `ARCHITECTURE.md`.

1. `docs/product-specs/testing.md`: product-spec-level overview — what the harness is, how scenarios work, how to author one, how to generate fixtures, how to run the suite, how to update a stale recording, how to add a new recipe fixture set. Written for an agent loading this file fresh.
2. `test/README.md`: quick-start checklist for the agent who just opened the directory. Points at `docs/product-specs/testing.md` for depth.
3. Add `testing.md` to `docs/product-specs/index.md` and the docs index in `CLAUDE.md`.
4. Add an `Integration and testing` section to `ARCHITECTURE.md` explaining the dispatch seam and the harness layering.
5. **Promote decisions + findings into a design doc.** Create `docs/design-docs/test-harness-architecture.md` by synthesizing this plan's `Decision log`, `Surprises & Discoveries`, and `Outcomes & Retrospective` sections. Unlike the plan's decision log (which captures pre-execution intent), the design doc captures **what actually shipped and why** — refined by implementation experience, including any decisions that were reversed or amended when reality diverged from the plan. Add the entry to `docs/design-docs/index.md`. This turns the rationale into a long-lived, discoverable artifact that outlives the plan once it moves to `plans/completed/`.

**Acceptance:** A fresh Claude Code instance reading only `CLAUDE.md` can find `testing.md`, read it, author a new scenario, generate fixtures, run the suite, and report results — without asking the user for guidance. The design doc exists, is linked from the index, and reflects the implementation's actual shape (not just the plan's pre-execution guesses). The plan itself moves to `plans/completed/` only after the design doc lands.

## Progress

- [x] Step 1: `BotCore` extraction + move debug footer into grammY adapter
- [x] Step 2: `StateStoreLike` interface + `TestStateStore` with `snapshot()`
- [x] Step 3: `FixtureLLMProvider` with request hash over `{model, reasoning, messages, json, maxTokens}` + unit tests (including json/maxTokens collision cases)
- [x] Step 4: Scenario authoring API (`defineScenario` as typed identity function, event helpers, spec hashing — no authoring-time callback validation, per decision log)
- [x] Step 5: Recipe fixture libraries (`six-balanced`, `minimal`) with README
- [x] Step 6: Test runner with serial execution + `CapturingOutputSink` + `finalStore` assertion
- [x] Step 7: Generate mode CLI + safety flags + cost reporting
- [x] Step 8: Three first scenarios + 005 regression proof (transcript + store state)
- [x] Step 9: `docs/product-specs/testing.md` + `test/README.md` + index updates + promote decisions/findings to `docs/design-docs/test-harness-architecture.md`

## Decision log

- **Decision:** Primary scenario path is agent-authored, not user-recorded. Recording from real Telegram is out of scope for plan 006.
  **Rationale:** The whole point of the harness is to give the agent a closed feedback loop. If scenario creation requires the user to sit down with Telegram, the user remains in the critical path and the agent is still blind between recordings. Agent-authored scenarios (spec.ts files the agent writes directly) deliver full autonomy. Recording is a nice-to-have for capturing realistic edge cases the agent wouldn't think to author, but it is strictly optional for the stated goal, and it adds significant complexity (recording wrappers, flush-on-command, state snapshot serialization). Cutting it makes the plan smaller, simpler, and ships autonomy sooner. Recording can be added later as a small follow-up plan that reuses the same BotCore dispatch seam and fixture format.
  **Date:** 2026-04-05

- **Decision:** `npm test` as the command name, standard Node convention.
  **Rationale:** Scenarios are tests. `npm test` is the universally-understood entry point. Using a bespoke name like `npm run scenario` would work but would surprise anyone (agent or human) expecting standard Node conventions. The `"test"` field in `package.json` is the idiomatic home for this.
  **Date:** 2026-04-05

- **Decision:** Replay mode uses Node's built-in `node:test` runner. Generate mode is a separate custom CLI script. No third-party test framework (no Vitest, no Jest, no Mocha).
  **Rationale:** The replay loop is a 1:1 fit for the unit-test model — one assertion per scenario, deepStrictEqual on captured outputs. `node:test` gives us discovery, name-pattern filtering, spec reporter, exit code discipline, and `--watch` mode for free, with zero new dependencies and with standard idioms any agent or human instantly recognizes. Vitest/Jest would be ceremony — we'd use <5% of their features and inherit a large dep tree for no gain. A hand-rolled runner would also work but would reinvent discovery, filtering, and reporting for no reason when node:test already ships with Node 22 (our runtime). Generate mode is the one operation that doesn't fit the test-runner model (it's a fixture-writing side-effect, not an assertion) so it lives as a plain CLI at `src/harness/generate.ts` invoked via `npm run test:generate -- <name>`. Both entry points share `runScenario` and the loaders — no duplication. Note: we do **not** take advantage of node:test's within-file parallelism — scenarios run serially because the harness mutates process-global state (clock freeze). See the "serial execution" decision below.
  **Date:** 2026-04-05

- **Decision:** Scenarios run serially within `test/scenarios.test.ts`. Parallelism is future work, gated on eliminating process-global state.
  **Rationale:** `src/harness/clock.ts` monkey-patches `Date.now` and the `Date` constructor as process-level globals to make `new Date()` calls in core code stable during replay. Two scenarios running concurrently would have one's clock-freeze clobber the other's, producing non-deterministic results — the exact failure mode the harness exists to prevent. Running scenarios serially in a single `for` loop registration sidesteps this cleanly and is fast enough for our scale (sub-second per scenario × dozens of scenarios = seconds total). Moving to parallelism later requires one of: (a) replacing the clock freeze with AsyncLocalStorage, (b) sandboxing each scenario in a worker thread, or (c) a per-scenario `Date` wrapper injected at every call site. None are needed yet. The Layer 1 change to move the debug footer out of core logic already eliminates the other major process-global blocker (`logger.operationEvents`), so the clock is the last remaining obstacle.
  **Date:** 2026-04-05

- **Decision:** `BotCore.dispatch` produces clean text with no debug footer. The footer append lives exclusively in `grammyOutputSink`, the real-Telegram adapter.
  **Rationale:** The current `reply()` helper at `src/telegram/bot.ts:92` appends `log.getDebugFooter()` to every outbound message. The footer content depends on timing-sensitive globals (`operationStart`, `operationEvents` in `src/debug/logger.ts:189-217`) and the DEBUG env var. Leaving this call inside core logic would make captured transcripts non-deterministic and force the harness to pin `DEBUG=0`. Moving the append into the grammY adapter is architecturally correct anyway (footer is a view-layer concern, not a core concern) and delivers three benefits at once: (1) harness transcripts are deterministic regardless of DEBUG mode, (2) core code stops touching a process-global, (3) production debug footers still work for real Telegram users because the grammY adapter appends them as before.
  **Date:** 2026-04-05

- **Decision:** The harness substitutes an in-memory `TestStateStore` via a `StateStoreLike` interface that lives in `src/state/store.ts` (production territory) alongside the real class. Production `StateStore` declares `implements StateStoreLike`.
  **Rationale (why the interface exists at all):** The harness cannot hit Supabase, and more importantly, flows call `store.savePlan`, `store.completeActivePlans`, etc. as load-bearing side effects. A transcript-only assertion model lets persistence bugs slip through — a plan that "looks approved" in Telegram but wasn't actually persisted is exactly the silent-failure class this harness exists to catch. `TestStateStore` records everything written and exposes `snapshot()` for assertions.
  **Rationale (why the interface lives in `src/state/`, not `src/harness/`):** `BotCore` (production runtime) must depend on this type. If the interface lived in `src/harness/test-store.ts`, production code would import from a test-only module — inverting the dependency direction and setting a precedent that makes test concerns leak into production. The interface is conceptually part of the state layer, so it belongs next to its implementation. The harness imports from production (`import type { StateStoreLike } from '../state/store.js'`), not the other way around.
  **Rationale (why `implements StateStoreLike` on the class, not structural typing):** Relying on structural typing alone means drift between the class and the interface is invisible until a harness build fails (or worse, until a test runs and produces wrong results). An explicit `implements` annotation turns drift into a compile-time error on the production side at the moment it happens. The cost is one line; the benefit is immediate fail-fast feedback.
  **Rationale (why `TestStateStore` mirrors production filter semantics exactly):** Production `getCurrentPlan()` filters `status in ['active', 'planning']`, not just `'active'`. A test store that only tracks `'active'` would silently diverge on any scenario with an in-progress plan, producing wrong assertions for the wrong reasons. Two drift guards cover this: (a) every mirrored method in `TestStateStore` carries a cross-reference comment pointing at the production line it shadows, so code review catches semantic changes; (b) unit tests on `TestStateStore` assert the query behavior directly against known seed data. An automated parity test against a real `StateStore` would be stronger but requires either module-level Supabase mocking or a DI refactor of `StateStore` — both out of scope for plan 006, tracked in `plans/tech-debt.md`.
  **Date:** 2026-04-05

- **Decision:** Golden transcripts capture keyboard type explicitly (`{ kind: 'reply', ... }` vs `{ kind: 'inline', ... }`), not a flat `string[][]`.
  **Rationale:** The bot uses both reply keyboards (persistent bottom menu via `Keyboard` class with `.persistent()`) and inline keyboards (in-flow actions via `InlineKeyboard` with callback data). They differ in how the user interacts (reply button sends label as text; inline button dispatches callback) and in how handlers route them (`matchMainMenu` on text vs `callback_query:data`). Collapsing them to `string[][]` would hide this distinction, and a bug where a handler sends an inline keyboard when a reply keyboard was expected (or vice versa) would pass the test while breaking the product. The tagged shape also preserves callback data for inline buttons, which is what scenarios need to match against `click('...')` events. Scenarios themselves must use the correct event type — `text('<label>')` for reply-keyboard buttons, `click('<callback_data>')` for inline.
  **Date:** 2026-04-05

- **Decision:** `defineScenario` does NOT validate that `click('...')` callback strings match real handlers. Typos surface at runtime via transcript diff, not at authoring time.
  **Rationale:** The bot's callback space is not a flat literal list. Handlers use prefix matching for parameterized callbacks: `meal_type_*`, `rv_*`, `rd_*`, `re_*`, `rp_*`, `plan_gen_gap_*`, `plan_skip_gap_*`, `plan_idea_gap_*` (`src/telegram/bot.ts:165,217,230,246,261,389,411,420`). A literal-registry check in the harness would reject valid dynamic callbacks like `click('rv_chicken-rice-bowl')`. A smarter check that understood prefix patterns would duplicate the bot's dispatch logic inside the harness and drift as the bot evolves. The harness's golden-transcript assertion already catches typos with high precision and specificity: a wrong callback either produces no handler match (outputs diverge at that step) or the wrong handler's output (outputs diverge at the next step), and `deepStrictEqual` fails loudly with a unified diff pointing at the bad event. Runtime failure via the assertion model is strictly more accurate than a parallel validation layer, and simpler. The tradeoff (agent sees the failure at test time rather than author time) is negligible because the agent runs tests as part of the authoring loop anyway.
  **Date:** 2026-04-05

- **Decision:** Generate mode is a separate command (`npm run test:generate`), never triggered implicitly by `npm test`. Missing fixtures fail the test with instructions to run generate.
  **Rationale:** Real LLM calls cost money and take time. An "auto-generate on missing" mode would silently burn credits during routine test runs — a bug class the harness should actively prevent. Keeping generate as a separate, explicitly-invoked command forces conscious action from the agent, which means conscious review of the generated fixtures before committing. The tiny friction of running a second command is a feature, not a cost.
  **Date:** 2026-04-05

- **Decision:** Scenarios live in a directory each, with `spec.ts` (author-written) and `recorded.json` (generated). Both committed.
  **Rationale:** `spec.ts` is small, type-checked, readable, and the main surface the agent edits. `recorded.json` is large (thousands of characters of LLM responses) and rarely read by hand — it's the tape, not the score. Separating them keeps specs pleasant to author and recordings pleasant to diff. Both committed because the recorded fixtures are part of the test definition, not ephemeral cache.
  **Date:** 2026-04-05

- **Decision:** Recipe fixture libraries are shared across scenarios via a string key (`recipeSet: 'six-balanced'`), not embedded per scenario.
  **Rationale:** Most scenarios want similar recipe libraries (realistic happy-path set, minimal edge-case set). Sharing eliminates duplication — update one file, all scenarios see it — and makes it easy to spin up new variants (`high-protein`, `vegetarian`, etc.). Git dedupes identical files anyway, but the logical sharing is what matters for maintainability. Scenarios that need a unique library can still embed a directory locally if the shared-set abstraction becomes a cage.
  **Date:** 2026-04-05

- **Decision:** `specHash` field in `recorded.json` detects stale recordings. Changed spec → hash mismatch → test fails with "regenerate" instructions.
  **Rationale:** Without this, a change to the event list in `spec.ts` silently runs against the old recording and reports false positives (or false negatives if outputs happen to line up). The spec hash makes stale recordings loud instead of silent. It covers the most common drift path (events change); prompt drift is separately caught by the LLM fixture hash mismatch.
  **Date:** 2026-04-05

- **Decision:** Request-hash matching for LLM fixtures, not call-order matching. Hash covers `{ model, reasoning, messages, json, maxTokens }`.
  **Rationale:** Call-order is simpler but brittle — any code change that alters LLM call sequence silently replays the wrong fixtures. Request-hash matches on content: same request → same response, different request → loud failure. The hash must cover **every field that affects the OpenAI response**, not just the messages. `src/ai/openai.ts:79-80` passes `json` (as `response_format`) and `maxTokens` (as `max_completion_tokens`) into the real request; both can change the shape or content of the response, so both must be in the hash. Omitting them would let two calls with identical messages but different response formats collide on the same key and replay the wrong fixture. `context` is deliberately excluded because it's a cost-tracking label (`src/ai/provider.ts:34-35`) and never reaches the wire.
  **Date:** 2026-04-05

- **Decision:** Freeze the clock at scenario level (record time == replay time).
  **Rationale:** Prompts contain date references like `THIS WEEK: 2026-04-06 to 2026-04-12` generated from `new Date()`. Without a frozen clock, the prompt differs between runs, the hash differs, the fixture misses. Freezing makes replay byte-identical to record. Alternative was stripping dates from prompts before hashing — messier, more fragile, loses the ability to detect date-logic regressions.
  **Date:** 2026-04-05

- **Decision:** Golden transcript comparison (full output list) as the only assertion mechanism in v0.0.4. No custom per-scenario assertions.
  **Rationale:** Golden transcripts catch every regression within a scenario, including ones the agent didn't anticipate. Tradeoff is that cosmetic UI text tweaks cause noisy diffs, but regenerating is a one-command operation and `git diff` makes intent visible before commit. Custom assertions add API surface and decision complexity. Start with the simpler mechanism; add assertions later only if golden proves too coarse.
  **Date:** 2026-04-05

- **Decision:** Voice messages are pre-transcribed in scenario events (`{ type: 'voice', transcribedText }`), not stored as audio.
  **Rationale:** The harness cannot replay Whisper deterministically without recording audio and either calling Whisper live (expensive, non-deterministic in practice) or mocking it. Whisper is a thin transcription layer; product logic only cares about the transcribed text. Capturing text at authoring time and skipping audio entirely is correct for this harness. Whisper-specific regressions are out of scope for this suite.
  **Date:** 2026-04-05

- **Decision:** Scenarios are fully self-contained — recipe files live inside the scenario's referenced fixture set (or embedded directory), and the runner never reads from the main `recipes/` directory.
  **Rationale:** The main recipe storage is expected to change (static markdown today; possibly Supabase, user-generated, or a shared library in future versions). Any scheme that references live recipes by path or git SHA breaks when that storage moves. Binding scenarios to their own fixture sets under `test/fixtures/recipes/` decouples them from production recipe architecture entirely — they remain valid regardless of where recipes live tomorrow. Storage cost is not a concern: recipe files are small and git dedupes identical blobs across sets.
  **Date:** 2026-04-05

- **Decision:** No CI integration in v0.0.4. The agent runs `npm test` manually before handing work to the user.
  **Rationale:** CI adds surface area (workflow files, secret handling, cache management) the prototype stage does not need. The exit-code discipline means CI is a mechanical drop-in later. CI lands when there is a team to gate merges against.
  **Date:** 2026-04-05

- **Decision:** Refactor `bot.ts` by extraction (pull logic out into `core.ts`), not by wrapping (add a layer around the existing code).
  **Rationale:** Wrapping preserves grammY coupling throughout the handler bodies and forces the harness to implement either a fake `ctx` object (large surface) or intercept at the grammY level (fragile). Extraction moves the logic into pure functions both adapters can call. Bigger one-time refactor, smaller ongoing maintenance cost.
  **Date:** 2026-04-05

## Validation

### End-to-end acceptance

After all steps complete, this sequence must work from a fresh clone:

```
$ npm install
$ npm run build
<ok>

$ npm run dev
<bot starts. Run the ONE-TIME Step 1 migration check: exercise every flow via real Telegram to
 confirm the BotCore extraction did not regress grammY integration. DEBUG=1 confirms the debug
 footer still appears in production. This is the only manual check in the plan.>
^C

$ npm test
# Output from node:test (spec reporter)
▶ 001-plan-week-happy-path (812ms)
▶ 002-plan-week-flex-move-regression (1243ms)
▶ 003-plan-week-minimal-recipes (895ms)

ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ duration_ms 2950

$ echo $?
0
```

### Generate flow

Authoring a new scenario must work autonomously:

```
# 1. Agent writes test/scenarios/004-new-scenario/spec.ts
$ npm test -- --test-name-pattern=004-new-scenario
✖ 004-new-scenario
  AssertionError: No recording. Run `npm run test:generate -- 004-new-scenario` to create.

ℹ tests 1
ℹ pass 0
ℹ fail 1

$ npm run test:generate -- 004-new-scenario
Generating fixtures for 004-new-scenario...
  ⚠ This will call the real LLM. Proceed? (any key / Ctrl-C to abort)
  <keystroke>
  calling gpt-5.4-mini... (1.2s, in: 1574 out: 11065, $0.0511)
  calling gpt-5.4-nano... (0.4s, in: 820 out: 180, $0.0008)
  Captured: 5 outputs, 2 LLM fixtures, spec hash a1b2c3...
  Wrote test/scenarios/004-new-scenario/recorded.json
  Total cost: $0.0519

$ npm test -- --test-name-pattern=004-new-scenario
▶ 004-new-scenario (712ms)
ℹ pass 1

$ git add test/scenarios/004-new-scenario
$ git status
  new file: test/scenarios/004-new-scenario/spec.ts
  new file: test/scenarios/004-new-scenario/recorded.json
```

### Regression proof (the 005 scenario)

Scenario `002-plan-week-flex-move-regression` must fail when the 005 fix is reverted and pass when it is restored. This is the proof the harness catches the exact class of bug it was built for:

```
$ npm test -- --test-name-pattern=002-plan-week-flex-move-regression
▶ 002-plan-week-flex-move-regression (1243ms)
ℹ pass 1

# Manually revert src/agents/plan-flow.ts:697-706: remove the gap-surfacing conditional
# that sets pendingGaps and returns presentRecipeGap. Without it, swap tail falls through
# to formatPlanProposal directly while recipesToGenerate stays populated and ignored.
$ npm test -- --test-name-pattern=002-plan-week-flex-move-regression
✖ 002-plan-week-flex-move-regression
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  ... 3 items in expected array are missing from actual array:
  - outputs[6]: { text: "Thu dinner needs a recipe — I'd suggest ...",
  -              keyboard: { kind: 'inline', buttons: [[
  -                { label: 'Generate it', callback: 'plan_gen_gap_0' },
  -                { label: 'I have an idea', callback: 'plan_idea_gap_0' },
  -                { label: 'Pick from my recipes', callback: 'plan_skip_gap_0' }]] } }
  - outputs[7]: { text: "Fri dinner needs a recipe — ...", keyboard: { ... 'plan_*_gap_1' } }
  - outputs[8]: { text: "Sun dinner needs a recipe — ...", keyboard: { ... 'plan_*_gap_2' } }
  ... and the regression-side actual[6] is the broken proposal with 10 slots instead of 13:
  + outputs[6]: { text: "Your week: ... Weekly: 17,051 cal over 10 slots
  +              (lunches clamped at 1000 cal — 1022 exceeds maximum) ...", keyboard: {...} }

  AssertionError [ERR_ASSERTION]: finalStore mismatch:
  + actual - expected
  - expected.finalStore.plans[0].batches.length: 7
  + actual.finalStore.plans[0].batches.length: 4

ℹ fail 1 (2 assertions failed)

# Restore the fix
$ npm test -- --test-name-pattern=002-plan-week-flex-move-regression
▶ 002-plan-week-flex-move-regression
ℹ pass 1
```

**Two independent failure signals fire in the same test run:**
1. **Outputs diff** — the three `planRecipeGapKeyboard` messages (callbacks `plan_*_gap_0`, `_1`, `_2`) that the 005 fix introduces are missing from the captured transcript; the regressed code skips straight to re-rendering the broken proposal. `deepStrictEqual` on the outputs array catches this.
2. **`finalStore` diff** — the persisted plan ends up with 4 batches (the survivors after batch dissolution) instead of 7 (4 survivors + 3 gap-resolved). `deepStrictEqual` on `recorded.expected.finalStore` catches this independently, so even if a future bug somehow produced the right transcript with a wrong persisted plan (or vice versa), one of the two assertions still fires.

This is the bar: a regression in the exact class of bug that motivated the harness produces a loud, specific, actionable failure with both the UI symptom and the persistence symptom visible in the same run.

### Fresh-agent bootstrap test

A fresh Claude Code instance, given only `CLAUDE.md` and the prompt "run the test suite and report results", should be able to:

1. Find `docs/product-specs/testing.md` via the docs index in CLAUDE.md.
2. Read it.
3. Run `npm test`.
4. Report pass/fail per scenario.

If any step fails, `testing.md` is incomplete and must be fixed. This is the bar for plan completion.

## Surprises & discoveries

### LLMs are not byte-deterministic for identical requests

The plan assumed one fixture per unique request hash was sufficient. Scenario 003 failed on its first replay because the recipe scaler is called multiple times with identical inputs (same recipe, same target, same servings → identical prompt → identical hash), and the real OpenAI model returns slightly different responses each time — different scaled ingredient amounts (60g vs 75g black beans), different actual calories (798 vs 802), etc.

The initial `FixtureLLMProvider` used `Map<hash, fixture>`, which deduplicated by hash, so the second replay call would get the wrong response. Fix: queue responses per hash. The first call with hash X gets the first recorded response, the second gets the second, over-dispatch falls back to the tail. Added a unit test to lock this behavior in.

This discovery reshaped the design doc: the "why" of queuing became a first-class architectural concern rather than an implementation detail.

### `setup.ts` needed `import 'dotenv/config'` (not just `??=` fallbacks)

The plan's `setup.ts` assumed `dotenv` was loaded elsewhere in the import chain. In practice the harness entry points (`test/scenarios.test.ts`, `src/harness/generate.ts`) never import `dotenv/config` — that lives in `src/index.ts`, which the harness bypasses entirely. The first generate attempt for scenario 001 hit OpenAI with the dummy harness key and got a 401. Fix: `import 'dotenv/config'` at the top of `setup.ts`, then `??=` fallbacks. Real `.env` values still win when present; dummies only fill in gaps.

### Error handling belongs in the grammY adapter, not the core

The plan implied errors should propagate in harness mode but didn't specify the mechanism. I initially kept the try/catch inside `BotCore.dispatch`, which silently swallowed OpenAI auth errors during the first generate attempt — the broken scenario "succeeded" with 0 LLM fixtures and 5 "Something went wrong" replies. Fix: remove the try/catch from core; each grammY handler in `bot.ts` wraps its own call to `dispatch` with a try/catch that logs and replies "Something went wrong." Harness runners have no such wrapper, so errors propagate to the test body and fail scenarios loudly — which is exactly what the harness exists for.

### UUID non-determinism in persisted state

Batch ids, plan ids, and meal slot ids come from `uuid.v4()` and change on every run. The plan didn't anticipate this. First attempt at scenario 001 replay failed on `finalSession` divergence purely because of UUID drift. Fix: `src/harness/normalize.ts` walks the captured structure and replaces every UUID with a stable `{{uuid:N}}` placeholder. Same normalization is applied in both `runner.ts` (for replay) and `generate.ts` (for recording), so comparison is apples-to-apples.

Monkey-patching `crypto.randomUUID` at scenario start was considered but rejected: the `uuid` npm package captures a reference at module-load time, so runtime patching has no effect. Normalization is simpler, makes recorded JSON far more diff-readable, and preserves cross-reference semantics (the same UUID in multiple positions gets the same placeholder, so a bug that swaps references still fires).

### Scenario 002 captured 1 gap, not 3

The plan's prose described the flex_move regression producing a Fri-Sun batch that dissolves into three orphan gaps when the flex moves to Saturday. With the actual six-balanced recipes the proposer's output yielded a different layout, and the recorded transcript has exactly 1 gap prompt surfacing after the swap. Extra `plan_skip_gap_*` clicks past that count turned out to be idempotent no-ops (the `pendingGaps` lookup returns undefined and the flow re-renders), so the skip chain is safe to leave slightly longer than strictly necessary. The regression proof still holds: reverting the 005 fix removes the single gap prompt from the transcript and the `outputs` diff fires.

## Outcomes & retrospective

All nine steps landed. The `npm test` suite runs 21 tests in under 600ms: 9 `FixtureLLMProvider` unit tests (including the per-hash queue case that surfaced during implementation), 9 `TestStateStore` unit tests, and 3 full scenarios (`001-plan-week-happy-path`, `002-plan-week-flex-move-regression`, `003-plan-week-minimal-recipes`). No network calls on replay. A fresh clone with no `.env` file runs replay cleanly.

The regression proof worked: reverting the 005 fix at `src/agents/plan-flow.ts:697-706` produces `outputs diverged from recorded transcript` on scenario 002 — the missing gap prompt lands on the outputs diff exactly where expected. Restoring the fix makes the scenario pass again. The harness catches the exact class of bug that motivated it.

The autonomy target was achieved: the agent can now ship a feature, author a scenario, generate fixtures via `npm run test:generate -- <name>`, commit, and use `npm test` as a fast local regression gate on every subsequent change. User Telegram interaction is still needed once per structural migration (as a sanity check after the Step 1 grammY extraction) but is not required for any ongoing development.

**What reshaped vs the plan:**
- Fixture queuing per hash (not anticipated; unit-tested and documented in the design doc).
- UUID normalization via post-capture walk (plan did not address UUIDs at all).
- `setup.ts` loads dotenv before applying dummy values.
- Error handling moved out of `BotCore.dispatch` entirely, consolidated in grammY adapter.

**What was simpler than expected:**
- `BotCore` extraction. The existing `reply()` helper in `bot.ts` had already abstracted over `ctx.reply`, so swapping it for a sink interface was straightforward.
- `StateStoreLike` interface. Only 5 methods are actually called from core/flows; the minimal surface kept the test store small.
- node:test integration. Zero friction — discovery, filtering, watch mode, exit codes all work out of the box.

**What was harder than expected:**
- Determinism. The plan treated "freeze the clock" as the only source of non-determinism; reality added UUIDs and LLM response variance on top. Both took real debugging to diagnose on first failed replay.

**Deferred to tech-debt (not done in this plan):**
- Parity test between `TestStateStore` and a real `StateStore` backed by a mocked Supabase client. Current coverage is behavioral unit tests per-method with cross-references to the production SQL predicate, which is sufficient for plan 006 but leaves a gap where mirroring could drift silently on the production side. Tracked in `docs/plans/tech-debt.md`.
- Scenario parallelism. Blocked on eliminating the clock-freeze process-global (options: AsyncLocalStorage, worker threads). Current serial execution is fast enough for v0.0.4 scale.
- CI integration. Exit codes are clean; adding a workflow is a mechanical drop-in when a team exists to gate merges against it.
