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
│   │   └── types.ts                      Core data models (PlanSession, Batch, Recipe, FlexSlot, etc.)
│   │
│   ├── solver/
│   │   ├── types.ts                      Solver I/O interfaces + PlanProposal, ProposedBatch, PlanProposerOutput
│   │   └── solver.ts                     Deterministic budget allocation algorithm
│   │
│   ├── qa/
│   │   ├── gate.ts                       QA retry-loop wrapper (validate → fix → retry)
│   │   └── validators/
│   │       ├── plan.ts                   Weekly plan constraint checker
│   │       ├── proposal.ts               PlanProposal invariant checker (13 rules, pre-solver gate)
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
│   │   ├── plan-reproposer.ts            Sub-agent: adjust existing plan per user request (Plan 025)
│   │   ├── plan-diff.ts                  Deterministic change summary generator (Plan 025)
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
│   │   ├── logger.ts                     Centralized logging (console + data/logs/debug.log)
│   │   └── costs.ts                      AI cost tracker (data/logs/costs.jsonl, session totals)
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
├── data/                                 Runtime output (gitignored except recipes)
│   ├── recipes/                          Recipe markdown files (YAML frontmatter + steps)
│   ├── logs/                             Debug logs (debug.log, costs.jsonl — gitignored)
│   ├── feedback.md                       In-product feedback log (gitignored, plan 022)
│   └── feedback-assets/                  Screenshot attachments (gitignored, plan 022)
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
- **Plan proposer** (`agents/plan-proposer.ts`) — Sub-agent that generates complete weekly plan proposals using the recipe DB, recent history, and variety rules. Always returns a complete plan. Batches are fridge-life constrained, not required to be calendar-consecutive.
- **Re-proposer** (`agents/plan-reproposer.ts`) — Sub-agent that adjusts an existing plan per user request. Single structured-output LLM call. Same output contract as the proposer (complete plan), same validator, same solver. Returns proposal, clarification, or failure. Replaces all deterministic mutation handlers (Plan 025).
- **Change summary** (`agents/plan-diff.ts`) — Deterministic diff between old and new proposals. Two-pass batch matching (recipe identity then day overlap for swaps). Used after re-proposer to show the user what changed.
- **Budget solver** (`solver/solver.ts`) — Deterministic code. Reserves a protected treat budget upfront (`config.planning.treatBudgetPercent`), then distributes the remaining weekly calories uniformly across all meal prep slots. Every batch gets the same per-slot target; the recipe scaler adjusts each recipe to hit it.
- **QA gate** (`qa/gate.ts`) — Validates all outputs before they reach the user. Retry loop with max 3 attempts. Proposal validation (`qa/validators/proposal.ts`) runs inside `proposePlan()` before the solver; 14 invariants cover slot coverage, fridge-life, flex count, recipe existence, event validity, and meal-type lane (Plan 026 #14: `batch.mealType ∈ recipe.mealTypes`).
- **Sub-agents** — Isolated LLM tasks: recipe generation (with meal-type-specific prompts), recipe scaling, restaurant estimation. Each runs with focused context and returns a condensed result.

**AI Layer** — LLM calls behind a provider interface. Three model tiers: primary (GPT-5.4, complex tasks), mini (GPT-5.4-mini, generation/reasoning), nano (GPT-5.4-nano, classification/parsing). Switching from OpenAI to another provider requires only a new implementation of `ai/provider.ts`.

---

## Key design rules

1. **The LLM never does calorie math.** The budget solver and QA gate are deterministic code. The LLM handles conversation, recipe generation, and estimation.

2. **Button taps bypass the LLM.** They map directly to flow handler actions. Only free-form text/voice goes through the LLM for interpretation.

3. **State lives outside the context window.** Plan sessions and batches persist in Supabase. Recipes live as markdown files. Flow handlers hold in-memory state for the current session. The planning model uses rolling 7-day horizons with first-class batches that can span horizon boundaries (Plan 007).

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
       │    ├─ agents/plan-proposer.ts  (sub-agent: initial plan proposals)
       │    │    └─ qa/validators/proposal.ts  (13-invariant pre-solver gate, retry on failure)
       │    ├─ agents/plan-reproposer.ts (sub-agent: adjust plan per user request)
       │    ├─ agents/plan-diff.ts      (deterministic change summary)
       │    ├─ agents/recipe-generator  (sub-agent: generate recipes on demand)
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
      exactly config.planning.flexSlotsPerWeek flex slots; batches are
      fridge-life constrained, not required to be consecutive)
  → validateProposal() gates the proposal (14 invariants); retries once with
     correction if invalid; returns {type:'failure'} if retry also fails
  → solver runs on proposal (reserves protected treat budget, distributes
     remaining budget uniformly across slots, validates weekly totals)
  → QA gate validates

Plan presented to user:
  → [Looks good!] → recipe-scaler runs on each batch (adjusts ingredients
                    to the solver's per-slot target ±20 cal, preserving protein)
                  → plan saved to Supabase, shopping list ready
  → user types adjustment (e.g. "move flex to Sunday", "swap beef for fish")
     → re-proposer returns complete new plan (or clarification question)
     → validateProposal() gates; retries once on failure
     → solver re-runs → diffProposals() generates change summary → re-presented
```

---

## Where to look for specific tasks

| Task | Start here |
|---|---|
| Change how the plan week flow works | `src/agents/plan-flow.ts` (phases + handlers) |
| Change how the plan proposer picks recipes | `src/agents/plan-proposer.ts` (system prompt + variety rules) |
| Fix budget math or allocation | `src/solver/solver.ts` |
| Change validation rules | `src/qa/validators/plan.ts`, `proposal.ts` (pre-solver, 14 invariants), `recipe.ts`, or `shopping-list.ts` |
| Add a new LLM provider | Implement `src/ai/provider.ts` interface |
| Change how recipes are stored | `src/recipes/parser.ts` (format), `src/recipes/database.ts` (CRUD) |
| Modify Telegram UI or buttons | `src/telegram/keyboards.ts`, `src/telegram/formatters.ts` |
| Change recipe generation prompts | `src/agents/recipe-generator.ts` |
| Change the recipe generate/edit flow | `src/agents/recipe-flow.ts` |
| Change emergency ingredient swap behavior (Plan 033) | `src/agents/ingredient-swap.ts` (agent), `src/plan/swap-applier.ts` (target resolution + persistence + rendering), `src/utils/swap-format.ts` (delta lines + guardrail validator), `src/recipes/renderer.ts` (cook-view delta block + `renderBreakfastCookView`) |
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
