# Flexie — Agent Coding Guidelines

## Documentation-first codebase

This codebase is designed for LLM coding agents working in parallel with minimal context pollution. Every piece of documentation exists so that an agent can load only what it needs — not the entire project.

### Code documentation requirements

Every file, class, and function must be documented. This is not optional.

- **Every file** starts with a doc comment explaining: what this file is for, what role it plays in the architecture, and how it connects to other parts of the system.
- **Every class** has a doc comment explaining: what it represents, what it's responsible for, and what it is NOT responsible for.
- **Every function** has a doc comment explaining: what it does, what its parameters mean, what it returns, and any non-obvious behavior.
- Documentation is written for LLMs, not humans. Be explicit about intent, constraints, and relationships. Don't assume shared context — state it.

When modifying code, update the documentation in the same change. Stale docs are worse than no docs.

### Product documentation

The `docs/` folder contains the canonical product documentation. Keep it up to date whenever product logic, architecture, or flows change. The docs are structured so that an agent working on a specific area can load a single relevant file.

#### Docs index

| File | Purpose | When to reference |
|---|---|---|
| `docs/PROJECT.md` | Vision and principles. The "why" behind every product decision. | When making product tradeoff decisions. This is the tiebreaker. |
| `docs/SPEC.md` | Technical product spec (v0.0.1). Architecture, data models, flows, solver, UI. | When implementing any feature. This is the source of truth for what to build. |
| `docs/ARCHITECTURE.md` | Project structure, module layout, dependency flow, data flow diagrams. | When navigating the codebase or adding new modules. Start here to find which file to edit. |
| `docs/LANDING-PAGE-CONTENT.md` | Marketing copy and product positioning. | When working on user-facing copy or onboarding. |
| `docs/OLD-PLANNER-PROMPT.md` | Legacy meal planner prompt. Predecessor to Flexie. | Reference only. Shows the original approach that Flexie replaces. |
| `docs/RECIPE-EXAMPLE.md` | Example recipe format. | When working on the recipe database or parser. |

When adding new docs, update this index. An agent should be able to read this file alone and know exactly which doc to load for any task.

### Architecture overview (for quick orientation)

Flexie is a Telegram bot that helps users manage a weekly calorie budget with flexibility for fun foods and real life. For deep dives into dependency flow and data flow diagrams, see `docs/ARCHITECTURE.md`.

#### Directory layout

```
flexy-agent/
├── src/
│   ├── index.ts                          Entry point — wires dependencies, starts bot
│   ├── config.ts                         Env config + hardcoded v0.0.1 user targets
│   ├── models/types.ts                   Core data models (WeeklyPlan, Recipe, MealSlot, etc.)
│   ├── solver/solver.ts                  Deterministic budget allocation algorithm
│   ├── qa/
│   │   ├── gate.ts                       QA retry-loop wrapper (validate → fix → retry)
│   │   └── validators/                   plan.ts, recipe.ts, shopping-list.ts
│   ├── ai/
│   │   ├── provider.ts                   LLM provider interface (agnostic)
│   │   └── openai.ts                     OpenAI implementation (GPT-5.4/mini + Whisper)
│   ├── agents/
│   │   ├── orchestrator.ts               Central coordinator: LLM + state machine
│   │   ├── recipe-generator.ts           Sub-agent: generate new recipes to macro targets
│   │   ├── recipe-scaler.ts              Sub-agent: scale existing recipes to new targets
│   │   └── restaurant-estimator.ts       Sub-agent: estimate restaurant meal calories
│   ├── state/
│   │   ├── machine.ts                    Deterministic flow state machine (planning steps)
│   │   └── store.ts                      Supabase persistence (plans + session state)
│   ├── recipes/
│   │   ├── parser.ts                     Markdown ↔ Recipe serialization
│   │   └── database.ts                   In-memory recipe DB backed by markdown files
│   ├── debug/
│   │   ├── logger.ts                     Centralized logging (console + logs/debug.log)
│   │   └── costs.ts                      AI cost tracker (logs/costs.jsonl, session totals)
│   ├── shopping/generator.ts             Derive shopping lists from weekly plans
│   └── telegram/
│       ├── bot.ts                        Bot setup, auth middleware, message routing
│       ├── keyboards.ts                  Reply + inline keyboard layouts
│       └── formatters.ts                 Data → user-friendly Telegram messages
├── recipes/                              Recipe markdown files (YAML frontmatter + steps)
├── logs/                                 Debug logs (gitignored, overwritten each session)
├── docs/                                 Product and architecture documentation
└── package.json, tsconfig.json, .env
```

#### Three layers

1. **Telegram Bot** (`src/telegram/`) — Pure UI. Routes messages to the orchestrator, sends responses back. Button taps bypass the LLM and go directly to the state machine. Voice messages are transcribed via Whisper then processed as text.
2. **Agent Harness** (`src/agents/`, `src/solver/`, `src/state/`, `src/qa/`, `src/recipes/`, `src/shopping/`) — The product. Orchestrator coordinates LLM + state machine; budget solver does pure arithmetic; QA gate validates all outputs before they reach the user (retry loop, max 3 attempts); sub-agents run with isolated context for recipe generation, scaling, and restaurant estimation.
3. **AI Layer** (`src/ai/`) — LLM calls behind a provider interface. Switching providers requires only a new implementation of `ai/provider.ts`.

#### Key design rules

1. **The LLM never does calorie math.** The budget solver and QA gate are deterministic code. The LLM handles conversation, recipe generation, and estimation.
2. **Button taps bypass the LLM.** They map directly to state machine transitions. Only free-form text/voice goes through the orchestrator.
3. **State lives outside the context window.** Weekly plans and session state persist in Supabase. Recipes live as markdown files.
4. **Sub-agents run with isolated context.** Focused task in, condensed result out (under 2,000 tokens).
5. **Nothing reaches the user without validation.** Every plan, recipe, and shopping list passes through the QA gate.

#### Where to look for specific tasks

| Task | Start here |
|---|---|
| Change the planning flow | `src/state/machine.ts` (steps), `src/agents/orchestrator.ts` (handlers) |
| Fix budget math or allocation | `src/solver/solver.ts` |
| Change validation rules | `src/qa/validators/plan.ts`, `recipe.ts`, or `shopping-list.ts` |
| Add a new LLM provider | Implement `src/ai/provider.ts` interface |
| Change recipe storage/format | `src/recipes/parser.ts` (format), `src/recipes/database.ts` (CRUD) |
| Modify Telegram UI or buttons | `src/telegram/keyboards.ts`, `src/telegram/formatters.ts` |
| Change recipe generation prompts | `src/agents/recipe-generator.ts` |
| Add a new sub-agent | Create in `src/agents/`, wire into orchestrator |
| Change persistence schema | `src/state/store.ts` (Supabase queries) |

### Tech stack

- TypeScript / Node.js
- Telegram Bot API
- OpenAI API behind provider interface: GPT-5.4 (complex tasks), GPT-5.4-mini (simple tasks), Whisper (STT). Both models support reasoning modes: none, low, medium, high, xhigh.
- Supabase (state, plans) + markdown files (recipes)

### Coding conventions

- Keep files focused. One responsibility per file.
- Prefer explicit over clever. An agent reading this code for the first time should understand it without needing surrounding context.
- When in doubt about a product decision, read `docs/PROJECT.md` — adherence and low friction always win.

## Debug workflow — how we iterate on this product

The primary development loop is: the user runs the bot, tests it manually via Telegram, then comes back here to discuss issues and request changes. The debug logging system (`src/debug/logger.ts`) is designed specifically for this workflow.

### When the user reports an issue from a test session

1. **Read `logs/debug.log` first.** This file contains the full session log — every Telegram message (incoming and outgoing), every AI call (model, reasoning mode, full prompts, full responses, token usage, duration), every flow state transition, and every QA validation result. Read this before asking questions.
2. **Correlate the user's complaint with the log.** The log is chronological with `[TG:IN]` / `[TG:OUT]` / `[AI:REQ]` / `[AI:RES]` / `[FLOW]` / `[QA]` tags. Find the relevant interaction, read what the AI was asked, what it returned, and what the bot sent.
3. **Diagnose from the log, then fix.** The log usually has enough context to understand the root cause without asking the user for more details. If the issue is a bad recipe, the log has the full prompt and response. If the issue is a flow bug, the log has the state transitions. Fix the issue based on what the log tells you.

### What the user will typically say

- "The recipe it generated was too heavy on carbs" → read the log, find the AI response, check the prompt constraints, fix the prompt or validation.
- "It asked me for preferences twice" → read the log, trace the flow state transitions, find the bug.
- "The macros didn't add up" → read the log, check the QA validation result, see if correction ran and what happened.

### Debug mode

The bot can run in debug mode (`DEBUG=1 npm run dev` or `npm run dev:debug`) which adds:
- Verbose console output (all tags, not just info+)
- A one-line debug footer on Telegram messages showing which AI models were used and timing (e.g., `─── debug: primary/high 3.4s 2300tok → correction 1/2 | total 4.8s`)
