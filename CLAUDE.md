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

Flexie is a Telegram bot that helps users manage a weekly calorie budget with flexibility for fun foods and real life. For the full project structure, module layout, dependency flow, and "where to look" guide, see `docs/ARCHITECTURE.md`. Summary of the three layers:

1. **Telegram Bot** (`src/telegram/`) — UI, buttons, voice/text input, message formatting
2. **Agent Harness** (`src/agents/`, `src/solver/`, `src/state/`, `src/qa/`, `src/recipes/`, `src/shopping/`) — Orchestrator + sub-agents, budget solver, recipe database, conversation flows, QA validation
3. **AI Layer** (`src/ai/`) — OpenAI API (LLM + Whisper STT) behind a provider interface

Key principle: the budget solver and QA validation are deterministic code. The LLM handles conversation, recipe generation, and estimation. Never let the LLM do calorie arithmetic.

### Tech stack

- TypeScript / Node.js
- Telegram Bot API
- OpenAI API behind provider interface: GPT-5.4 (complex tasks), GPT-5.4-mini (simple tasks), Whisper (STT). Both models support reasoning modes: none, low, medium, high, xhigh.
- Supabase (state, plans) + markdown files (recipes)

### Coding conventions

- Keep files focused. One responsibility per file.
- Prefer explicit over clever. An agent reading this code for the first time should understand it without needing surrounding context.
- When in doubt about a product decision, read `docs/PROJECT.md` — adherence and low friction always win.
