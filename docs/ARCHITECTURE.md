# Flexie — Project Structure & Architecture

## Overview

Flexie is a Telegram bot that manages a weekly calorie budget with built-in flexibility for fun foods, restaurants, and real life. The codebase is organized by responsibility — each directory owns one concern, and files within it are focused on a single job.

For the product vision behind these decisions, see [PROJECT.md](./PROJECT.md).
For the full technical spec, see [SPEC.md](./SPEC.md).

---

## Directory layout

```
flexy-agent/
├── src/
│   ├── index.ts                          Entry point — wires dependencies, starts bot
│   ├── config.ts                         Env config + hardcoded v0.0.1 user targets
│   │
│   ├── models/
│   │   └── types.ts                      Core data models (WeeklyPlan, Recipe, MealSlot, etc.)
│   │
│   ├── solver/
│   │   ├── types.ts                      Solver-specific I/O interfaces
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
│   │   └── openai.ts                     OpenAI implementation (GPT-5.4/mini + Whisper)
│   │
│   ├── agents/
│   │   ├── orchestrator.ts               Central coordinator: LLM + state machine
│   │   ├── recipe-generator.ts           Sub-agent: generate new recipes to macro targets
│   │   ├── recipe-scaler.ts              Sub-agent: scale existing recipes to new targets
│   │   └── restaurant-estimator.ts       Sub-agent: estimate restaurant meal calories
│   │
│   ├── state/
│   │   ├── machine.ts                    Deterministic flow state machine (planning steps)
│   │   └── store.ts                      Supabase persistence (plans + session state)
│   │
│   ├── recipes/
│   │   ├── parser.ts                     Markdown ↔ Recipe serialization
│   │   └── database.ts                   In-memory recipe DB backed by markdown files
│   │
│   ├── debug/
│   │   ├── logger.ts                     Centralized logging (console + logs/debug.log)
│   │   └── costs.ts                      AI cost tracker (logs/costs.jsonl, session totals)
│   │
│   ├── shopping/
│   │   └── generator.ts                  Derive shopping lists from weekly plans
│   │
│   └── telegram/
│       ├── bot.ts                        Bot setup, auth middleware, message routing
│       ├── keyboards.ts                  Reply + inline keyboard layouts
│       └── formatters.ts                 Data → user-friendly Telegram messages
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
│  Orchestrator, state machine, budget solver,     │
│  recipe database, QA gate, shopping lists        │
├──────────────────────────────────────────────────┤
│  AI Layer (src/ai/)                              │
│  LLM provider interface → OpenAI implementation  │
│  GPT-5.4, GPT-5.4-mini, Whisper STT             │
└──────────────────────────────────────────────────┘
```

**Telegram Bot** — Pure UI. Routes messages to the orchestrator, sends responses back. Button taps bypass the LLM and go directly to the state machine. Voice messages are transcribed via Whisper then processed as text.

**Agent Harness** — The product. Contains all business logic:
- **Orchestrator** (`agents/orchestrator.ts`) — The central coordinator. An LLM constrained by a deterministic state machine. Delegates heavy work to sub-agents, math to the solver, and validation to the QA gate.
- **State machine** (`state/machine.ts`) — Deterministic rails for the planning flow. Controls step progression, valid transitions, and data gates. Never hallucinates.
- **Budget solver** (`solver/solver.ts`) — Pure arithmetic. Allocates the weekly calorie budget across breakfast, events, fun foods, and meal prep batches. No LLM involved.
- **QA gate** (`qa/gate.ts`) — Validates all outputs before they reach the user. Retry loop with max 3 attempts.
- **Sub-agents** — Isolated LLM tasks: recipe generation, recipe scaling, restaurant estimation. Each runs with focused context and returns a condensed result.

**AI Layer** — LLM calls behind a provider interface. Switching from OpenAI to another provider requires only a new implementation of `ai/provider.ts`.

---

## Key design rules

1. **The LLM never does calorie math.** The budget solver and QA gate are deterministic code. The LLM handles conversation, recipe generation, and estimation.

2. **Button taps bypass the LLM.** They map directly to state machine transitions. Only free-form text/voice goes through the orchestrator LLM for interpretation.

3. **State lives outside the context window.** Weekly plans and session state persist in Supabase. Recipes live as markdown files. The orchestrator holds lightweight references and reads data on demand.

4. **Sub-agents run with isolated context.** They receive a focused task, do deep work, and return a condensed result (under 2,000 tokens). The orchestrator never sees the sub-agent's full working context.

5. **Nothing reaches the user without validation.** Every plan, recipe, and shopping list passes through the QA gate before being shown. If validation fails, the system retries up to 3 times.

6. **The provider interface is agnostic.** All LLM calls go through `ai/provider.ts`. Switching providers means implementing a new class, not rewriting business logic.

---

## Module dependency flow

```
index.ts
  └─ config.ts
  └─ ai/openai.ts ← ai/provider.ts
  └─ recipes/database.ts ← recipes/parser.ts ← models/types.ts
  └─ state/store.ts ← state/machine.ts
  └─ agents/orchestrator.ts
  │    ├─ state/machine.ts        (flow control)
  │    ├─ solver/solver.ts        (budget math)
  │    ├─ qa/gate.ts              (validation)
  │    ├─ agents/recipe-generator  (sub-agent)
  │    ├─ agents/recipe-scaler     (sub-agent)
  │    ├─ agents/restaurant-est.   (sub-agent)
  │    ├─ shopping/generator.ts   (list derivation)
  │    └─ telegram/formatters.ts  (message output)
  └─ telegram/bot.ts ← telegram/keyboards.ts
```

---

## Data flow during a planning session

```
User taps "Plan Week"
  → bot.ts routes to orchestrator
  → orchestrator activates state machine (planning:breakfast)
  → state machine gates each step

For each step:
  Button tap → state machine transition (no LLM)
  Free text / voice → LLM interprets → state machine validates

After all steps:
  orchestrator → solver (allocate budget)
  solver output → QA gate (validate plan)
  QA pass → recipe scaler sub-agent (scale batches)
  scaled recipes → QA gate (validate recipes)
  QA pass → state store (persist plan)
  plan → formatters → bot → Telegram
```

---

## Where to look for specific tasks

| Task | Start here |
|---|---|
| Change how the planning flow works | `src/state/machine.ts` (steps), `src/agents/orchestrator.ts` (handlers) |
| Fix budget math or allocation | `src/solver/solver.ts` |
| Change validation rules | `src/qa/validators/plan.ts`, `recipe.ts`, or `shopping-list.ts` |
| Add a new LLM provider | Implement `src/ai/provider.ts` interface |
| Change how recipes are stored | `src/recipes/parser.ts` (format), `src/recipes/database.ts` (CRUD) |
| Modify Telegram UI or buttons | `src/telegram/keyboards.ts`, `src/telegram/formatters.ts` |
| Change recipe generation prompts | `src/agents/recipe-generator.ts` |
| Add a new sub-agent | Create in `src/agents/`, wire into orchestrator |
| Change persistence schema | `src/state/store.ts` (Supabase queries) |
