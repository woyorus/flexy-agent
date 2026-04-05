# Flexie — Project Structure & Architecture

> Scope: Codebase structure, module layout, dependency flow, data flow diagrams. See also: [PRODUCT_SENSE.md](./PRODUCT_SENSE.md) for the "why", [product-specs/](./product-specs/) for what to build.

## Overview

Flexie is a Telegram bot that manages a weekly calorie budget with built-in flexibility for fun foods, restaurants, and real life. The codebase is organized by responsibility — each directory owns one concern, and files within it are focused on a single job.

---

## Directory layout

```
flexy-agent/
├── src/
│   ├── index.ts                          Entry point — wires dependencies, starts bot
│   ├── config.ts                         Env config + hardcoded v0.0.1 user targets + food profile
│   │
│   ├── models/
│   │   └── types.ts                      Core data models (WeeklyPlan, Recipe, MealSlot, FlexSlot, etc.)
│   │
│   ├── solver/
│   │   ├── types.ts                      Solver I/O interfaces + PlanProposal, ProposedBatch, RecipeGap
│   │   └── solver.ts                     Deterministic budget allocation algorithm
│   │
│   ├── qa/
│   │   ├── gate.ts                       QA retry-loop wrapper (validate → fix → retry)
│   │   └── validators/
│   │       ├── plan.ts                   Weekly plan constraint checker
│   │       ├── recipe.ts                 Recipe macro/consistency checker
│   │       └── shopping-list.ts          Shopping list completeness checker
│   │
│   ├── ai/
│   │   ├── provider.ts                   LLM provider interface (agnostic)
│   │   └── openai.ts                     OpenAI implementation (GPT-5.4/mini/nano + Whisper)
│   │
│   ├── agents/
│   │   ├── plan-flow.ts                  Plan week flow handler (suggestive-first planning)
│   │   ├── plan-proposer.ts              Sub-agent: propose weekly plan (variety + flex slots)
│   │   ├── recipe-flow.ts               Recipe generation/edit flow handler
│   │   ├── recipe-generator.ts           Sub-agent: generate new recipes to macro targets
│   │   ├── recipe-scaler.ts              Sub-agent: scale existing recipes to new targets
│   │   └── restaurant-estimator.ts       Sub-agent: estimate restaurant meal calories
│   │
│   ├── state/
│   │   ├── machine.ts                    Deterministic flow state machine (first-run steps)
│   │   └── store.ts                      Supabase persistence (plans + session state)
│   │
│   ├── recipes/
│   │   ├── parser.ts                     Markdown ↔ Recipe serialization
│   │   ├── renderer.ts                   Recipe → Telegram display text
│   │   └── database.ts                   In-memory recipe DB backed by markdown files
│   │
│   ├── debug/
│   │   ├── logger.ts                     Centralized logging (console + logs/debug.log)
│   │   └── costs.ts                      AI cost tracker (logs/costs.jsonl, session totals)
│   │
│   ├── shopping/
│   │   └── generator.ts                  Derive shopping lists from weekly plans
│   │
│   ├── telegram/
│   │   ├── bot.ts                        grammY adapter: middlewares, handlers, sink wiring
│   │   ├── core.ts                       BotCore: headless dispatch + session state
│   │   ├── keyboards.ts                  Reply + inline keyboard layouts
│   │   └── formatters.ts                 Data → user-friendly Telegram messages
│   │
│   └── harness/
│       ├── index.ts                      Public barrel for test/ consumers
│       ├── define.ts                     defineScenario + event helpers
│       ├── types.ts                      Scenario + captured-output types
│       ├── loader.ts                     discoverScenarios, loadScenario
│       ├── runner.ts                     runScenario: wires deps, drives BotCore, returns result
│       ├── generate.ts                   CLI for recording fixtures against the real LLM
│       ├── test-store.ts                 In-memory StateStoreLike for scenarios
│       ├── capturing-sink.ts             OutputSink that serializes replies for assertions
│       ├── clock.ts                      Date-freeze utility for scenario replay
│       └── normalize.ts                  UUID → {{uuid:N}} normalization
│
├── recipes/                              Recipe markdown files (YAML frontmatter + steps)
│
├── logs/                                 Debug logs (gitignored, overwritten each session)
│
├── docs/                                 Product and architecture documentation
│
└── package.json, tsconfig.json, .env
```

---

## Three-layer architecture

```
┌──────────────────────────────────────────────────┐
│  Telegram Bot (src/telegram/)                    │
│  UI, buttons, voice input, message formatting    │
├──────────────────────────────────────────────────┤
│  Agent Harness (src/agents/, src/solver/,        │
│    src/state/, src/qa/, src/recipes/,            │
│    src/shopping/)                                │
│  Flow handlers, plan proposer, budget solver,    │
│  recipe database, QA gate, shopping lists        │
├──────────────────────────────────────────────────┤
│  AI Layer (src/ai/)                              │
│  LLM provider interface → OpenAI implementation  │
│  GPT-5.4, GPT-5.4-mini, GPT-5.4-nano, Whisper   │
└──────────────────────────────────────────────────┘
```

**Telegram Bot** — Pure UI. Routes messages to flow handlers, sends responses back. Button taps bypass the LLM and map directly to flow actions. Voice messages are transcribed via Whisper then processed as text.

**Agent Harness** — The product. Contains all business logic:
- **Flow handlers** (`agents/plan-flow.ts`, `agents/recipe-flow.ts`) — Phase-driven state machines for the planning and recipe flows. Each exports a state type, factory function, and pure handler functions that return `{text, state}`.
- **Plan proposer** (`agents/plan-proposer.ts`) — Sub-agent that generates complete weekly plan proposals using the recipe DB, recent history, and variety rules.
- **Budget solver** (`solver/solver.ts`) — Deterministic code. Reserves a protected treat budget upfront (`config.planning.treatBudgetPercent`), then distributes the remaining weekly calories uniformly across all meal prep slots. Every batch gets the same per-slot target; the recipe scaler adjusts each recipe to hit it.
- **QA gate** (`qa/gate.ts`) — Validates all outputs before they reach the user. Retry loop with max 3 attempts.
- **Sub-agents** — Isolated LLM tasks: recipe generation (with meal-type-specific prompts), recipe scaling, restaurant estimation. Each runs with focused context and returns a condensed result.

**AI Layer** — LLM calls behind a provider interface. Three model tiers: primary (GPT-5.4, complex tasks), mini (GPT-5.4-mini, generation/reasoning), nano (GPT-5.4-nano, classification/parsing). Switching from OpenAI to another provider requires only a new implementation of `ai/provider.ts`.

---

## Key design rules

1. **The LLM never does calorie math.** The budget solver and QA gate are deterministic code. The LLM handles conversation, recipe generation, and estimation.

2. **Button taps bypass the LLM.** They map directly to flow handler actions. Only free-form text/voice goes through the LLM for interpretation.

3. **State lives outside the context window.** Weekly plans persist in Supabase. Recipes live as markdown files. Flow handlers hold in-memory state for the current session.

4. **Sub-agents run with isolated context.** They receive a focused task, do deep work, and return a condensed result. The flow handler never sees the sub-agent's full working context.

5. **Nothing reaches the user without validation.** Every plan, recipe, and shopping list passes through the QA gate before being shown. If validation fails, the system retries up to 3 times.

6. **The provider interface is agnostic.** All LLM calls go through `ai/provider.ts`. Switching providers means implementing a new class, not rewriting business logic.

7. **Treat budget is protected, meal slots are uniform.** The solver reserves a fixed treat budget (`config.planning.treatBudgetPercent` of weekly calories) before sizing meals, then distributes the remainder evenly across all meal prep slots. Each recipe is scaled at plan approval time to hit its assigned per-slot target (±20 cal tolerance for clean ingredient amounts). Protein is preserved precisely during scaling.

8. **The food profile shapes all generation.** `config.foodProfile` (region, store access, ingredient preferences) is injected into every recipe generation and plan proposal prompt.

---

## Module dependency flow

```
index.ts
  └─ config.ts
  └─ ai/openai.ts ← ai/provider.ts
  └─ recipes/database.ts ← recipes/parser.ts ← models/types.ts
  └─ state/store.ts
  └─ telegram/bot.ts
       ├─ agents/plan-flow.ts           (plan week flow)
       │    ├─ agents/plan-proposer.ts  (sub-agent: plan proposals)
       │    ├─ agents/recipe-generator  (sub-agent: gap recipes)
       │    ├─ agents/recipe-scaler.ts  (sub-agent: scale recipes to solver targets at approval)
       │    ├─ solver/solver.ts         (budget math)
       │    ├─ qa/validators/plan.ts    (validation)
       │    └─ state/store.ts           (persistence)
       ├─ agents/recipe-flow.ts         (recipe generate/edit flow)
       │    ├─ agents/recipe-generator  (sub-agent)
       │    └─ qa/validators/recipe.ts  (validation)
       ├─ recipes/renderer.ts           (display)
       └─ telegram/keyboards.ts         (UI)
```

---

## Data flow during a planning session

```
User taps "Plan Week"
  → bot.ts creates PlanFlowState
  → shows breakfast confirmation + events question

User confirms breakfast, adds meal-replacement events (or none — treats are
  never declared here, they come from the protected treat budget)
  → plan-proposer sub-agent runs
     (recipe DB + recent history + variety rules → complete proposal with
      exactly config.planning.flexSlotsPerWeek flex slots)
  → solver runs on proposal (reserves protected treat budget, distributes
     remaining budget uniformly across slots, validates weekly totals)
  → QA gate validates

If recipe gaps found:
  → user prompted: [Generate it] [I have an idea] [Skip]
  → recipe-generator sub-agent fills the gap
  → solver re-runs with complete batches

Plan presented to user:
  → [Looks good!] → recipe-scaler runs on each batch (adjusts ingredients
                    to the solver's per-slot target ±20 cal, preserving protein)
                  → plan saved to Supabase, shopping list ready
  → [Swap something] → user describes change → LLM classifies swap type
     (flex_add, flex_remove, flex_move, recipe_swap, unclear)
     → proposal mutated → solver re-runs → re-presented
```

---

## Where to look for specific tasks

| Task | Start here |
|---|---|
| Change how the plan week flow works | `src/agents/plan-flow.ts` (phases + handlers) |
| Change how the plan proposer picks recipes | `src/agents/plan-proposer.ts` (system prompt + variety rules) |
| Fix budget math or allocation | `src/solver/solver.ts` |
| Change validation rules | `src/qa/validators/plan.ts`, `recipe.ts`, or `shopping-list.ts` |
| Add a new LLM provider | Implement `src/ai/provider.ts` interface |
| Change how recipes are stored | `src/recipes/parser.ts` (format), `src/recipes/database.ts` (CRUD) |
| Modify Telegram UI or buttons | `src/telegram/keyboards.ts`, `src/telegram/formatters.ts` |
| Change recipe generation prompts | `src/agents/recipe-generator.ts` |
| Change the recipe generate/edit flow | `src/agents/recipe-flow.ts` |
| Add a new sub-agent | Create in `src/agents/`, wire into the relevant flow handler |
| Change persistence schema | `src/state/store.ts` (Supabase queries) |
| Change user food preferences | `src/config.ts` (`foodProfile` section) |
| Run the test suite | `npm test` — see `docs/product-specs/testing.md` for the full reference |
| Author a new scenario or update a stale recording | `docs/product-specs/testing.md` |

---

## Integration and testing

The Telegram layer is split into two files to support headless testing:

- **`src/telegram/core.ts`** (`BotCore`) — contains ALL conversation logic. Exposes `dispatch(update, sink)` where `update` is a `HarnessUpdate` (`command` / `text` / `callback` / `voice`) and `sink` is an `OutputSink` (three methods: `reply`, `answerCallback`, `startTyping`). Session state lives on `core.session` and is mutated in place.
- **`src/telegram/bot.ts`** — the grammY adapter. Registers middlewares (auth, inbound logging, operation-timer), translates `ctx` into `HarnessUpdate`, builds a `grammyOutputSink` that forwards to `ctx.reply` and appends the debug footer, and calls `core.dispatch(update, sink)`.

The test harness (`src/harness/`) drives the same `BotCore` via its own runner: constructs a `FixtureLLMProvider` and `TestStateStore` instead of the real OpenAI/Supabase dependencies, freezes `Date`, loops events into `core.dispatch`, and captures every reply via a `CapturingOutputSink`. Three independent assertions (`outputs`, `finalSession`, `finalStore`) run against the recording in `recorded.json`.

The debug footer append lives exclusively inside the grammY adapter. `BotCore` produces clean text so harness transcripts are byte-stable regardless of DEBUG mode. Error handling also lives in the grammY adapter — core throws, grammY handlers catch and reply "Something went wrong" while harness runners let errors propagate so scenarios fail loudly.

See `docs/product-specs/testing.md` and `docs/design-docs/test-harness-architecture.md` for the full harness reference.
