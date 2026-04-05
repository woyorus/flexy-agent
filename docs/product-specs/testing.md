# Testing — Scenario Harness

> Scope: How the Flexie test harness works, how to author scenarios, how to generate fixtures, how to run the suite. See also: [ARCHITECTURE.md](../ARCHITECTURE.md) for where the harness lives in the codebase, [design-docs/test-harness-architecture.md](../design-docs/test-harness-architecture.md) for the "why" behind design decisions.

## What the harness is

A closed feedback loop for the coding agent. Scenarios are short TypeScript files that describe user interactions with the Flexie bot — commands, text messages, button taps, voice transcriptions. Each scenario has a companion `recorded.json` with expected outputs, session state, persistence state, and captured LLM responses. `npm test` replays every scenario against the recorded fixtures in under a second per scenario, with no network calls.

The harness exists so the agent can:

1. Ship a feature.
2. Author a scenario covering it.
3. Generate fixtures once via the real LLM.
4. Commit.
5. On every subsequent change, `npm test` catches regressions without any user involvement or Telegram interaction.

It does NOT require a user to sit with Telegram and record traces by hand. Scenarios are written as code.

## Quick commands

```bash
npm test                                            # replay all scenarios + unit tests
npm test -- --test-name-pattern="plan-week"         # filter by scenario name regex
npm run test:generate -- <scenario-name>            # generate fixtures (costs real LLM $)
npm run test:generate -- <scenario-name> --regenerate   # overwrite existing fixtures
```

Generate mode prompts for confirmation before calling the real LLM unless stdin is not a TTY (automated contexts) or `--yes` is passed.

## Directory layout

```
test/
├── scenarios/
│   ├── 001-plan-week-happy-path/
│   │   ├── spec.ts           ← agent-authored: events, initial state, clock
│   │   └── recorded.json     ← generated: expected outputs + LLM fixtures
│   ├── 002-plan-week-flex-move-regression/
│   └── 003-plan-week-minimal-recipes/
├── fixtures/
│   └── recipes/              ← curated recipe libraries scenarios reference by name
│       ├── six-balanced/
│       └── minimal/
├── unit/                     ← node:test unit tests for harness internals
├── setup.ts                  ← dummy env preload (dotenv + fallback values)
└── scenarios.test.ts         ← node:test entry point (discovers + runs everything)

src/harness/
├── index.ts                  ← public barrel
├── define.ts                 ← defineScenario + event helpers (command/text/click/voice)
├── types.ts                  ← Scenario, RecordedScenario, CapturedOutput, etc.
├── loader.ts                 ← discoverScenarios, loadScenario
├── runner.ts                 ← runScenario — wires deps, drives dispatch, returns result
├── generate.ts               ← CLI for recording new fixtures
├── test-store.ts             ← in-memory StateStoreLike implementation
├── capturing-sink.ts         ← OutputSink that records reply() calls
├── clock.ts                  ← freezes Date for the scenario's fixed timestamp
└── normalize.ts              ← normalizes UUIDs to {{uuid:N}} placeholders
```

## Authoring a scenario

1. Create `test/scenarios/<NNN-short-name>/spec.ts`.
2. Import `defineScenario` and event helpers from `../../../src/harness/define.js`.
3. Export a default scenario:

```typescript
import { defineScenario, command, text, click } from '../../../src/harness/define.js';

export default defineScenario({
  name: '004-my-new-scenario',
  description: 'One-line summary for failure messages and diffs',
  clock: '2026-04-05T10:00:00Z',              // frozen Date for entire run
  recipeSet: 'six-balanced',                  // directory under test/fixtures/recipes/
  initialState: {
    plans: [],                                // TestStateStore seed
    session: null,
  },
  events: [
    command('start'),
    text('📋 Plan Week'),                     // reply-keyboard button → text
    click('plan_keep_breakfast'),             // inline button → callback
    click('plan_no_events'),
    click('plan_approve'),
  ],
});
```

4. Generate fixtures: `npm run test:generate -- 004-my-new-scenario`.
5. Inspect `recorded.json` via `git diff` — confirm captured outputs look right.
6. Run `npm test` — the new scenario should now pass.
7. Commit `spec.ts` and `recorded.json` together.

### Reply keyboards vs inline keyboards

The distinction matters:

- **Reply keyboard buttons** (persistent main menu: "📋 Plan Week", "🛒 Shopping List", etc.) arrive as plain text messages with the button's label. Use `text('<label>')`.
- **Inline keyboard buttons** (in-flow buttons like "Keep it", "Looks good!", "Swap something") arrive as callback queries with a `callback_data` string. Use `click('<callback_data>')`.

Get this wrong and the scenario exercises the wrong code path. The captured transcript diff catches the mistake loudly, but knowing up front saves a regenerate cycle.

## Updating a stale recording

If the spec changes (new event, different initial state, different recipeSet, different clock), the `specHash` in `recorded.json` no longer matches the current spec. The runner detects this and fails with:

```
Stale recording: spec hash changed since last generate.
  recorded specHash: a1b2c3d4e5f6…
  current  specHash: 9f8e7d6c5b4a…
Run: npm run test:generate -- <name> --regenerate
```

Run the suggested command, review the diff, commit.

If the spec is unchanged but the BEHAVIOR of `BotCore.dispatch` changed (new reply, different wording, modified solver output), the scenario fails with an assertion diff. Decide whether the new behavior is intentional:
- Intentional → regenerate and commit the new recording.
- Unintentional → fix the code.

## Adding a new recipe fixture set

1. Create `test/fixtures/recipes/<set-name>/`.
2. Drop in markdown recipe files in the same format as `recipes/` production files.
3. Reference the set from a scenario via `recipeSet: '<set-name>'`.
4. Document it in [test/fixtures/recipes/README.md](../../test/fixtures/recipes/README.md).

Fixture sets are copies, not symlinks. Production recipe edits don't cascade to tests — scenarios are bound to their own fixture data by design.

## Determinism guarantees

The harness normalizes two sources of non-determinism so replays are byte-stable:

1. **Clock**: `freezeClock(spec.clock)` monkey-patches `Date` for the scenario duration. Every `new Date()` inside `BotCore.dispatch` returns the fixed instant, so prompts containing date references produce stable hashes.
2. **UUIDs**: Batch ids, plan ids, and meal slot ids from `uuid.v4()` are replaced with `{{uuid:0}}`, `{{uuid:1}}`, … tokens before comparison. The relationship between ids is preserved (same UUID → same placeholder everywhere it appears), so cross-reference bugs still fail the diff.

## What the tests assert

Every scenario asserts three things independently via `assert.deepStrictEqual`:

1. **`outputs`** — the full captured Telegram transcript (text + keyboard shape for each reply).
2. **`finalSession`** — `BotCore.session` at the end of the event loop.
3. **`finalStore`** — the `TestStateStore.snapshot()` result at the end of the scenario.

A bug that produces a correct transcript but skips persistence still fires because `finalStore` diverges. A bug that persists correctly but sends the wrong message fires on `outputs`. Both assertions are load-bearing — the harness exists to catch the exact class of silent failure where one is right and the other isn't.

## Fixture handling for non-deterministic LLM calls

LLMs aren't byte-deterministic for identical requests. The recipe scaler calls with identical inputs multiple times (same recipe, same target, same servings → identical prompt → identical hash), and the real model returns slightly different responses each time. `FixtureLLMProvider` keeps a queue per hash: the first call gets the first recorded response, the second gets the second, and so on. Over-dispatch (more replay calls than recorded) keeps replaying the last fixture rather than throwing.

If a missing fixture is genuinely absent (prompt changed, new call path), `MissingFixtureError` surfaces with the three closest recorded fixtures by Levenshtein distance on the last user message, plus the exact regenerate command.

## Running against a dirty `.env`

The harness works with or without a real `.env` file. `test/setup.ts` loads `dotenv` first, then fills in dummy values for anything still unset. Replay mode needs no credentials — `FixtureLLMProvider` and `TestStateStore` intercept every call that would touch the network. Generate mode needs `OPENAI_API_KEY` in `.env` because it calls the real API.

The dummy values (`harness-dummy-no-network`, `https://harness-dummy.invalid`) are deliberately obvious — if a failure mentions one of them, something is bypassing the harness and trying to hit the network.
