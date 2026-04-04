# Flexie — Agent Coding Guidelines

## Documentation-first codebase

This codebase is designed for LLM coding agents. Every piece of documentation exists so that an agent can load only what it needs — not the entire project. CLAUDE.md is the map. Load a specific doc when you need depth.

### Code documentation requirements

Every file, class, and function must be documented. This is not optional.

- **Every file** starts with a doc comment: what it's for, its role in the architecture, how it connects to other parts.
- **Every class/function** has a doc comment: what it does, parameters, return values, non-obvious behavior.
- Documentation is written for LLMs. Be explicit about intent, constraints, and relationships.
- When modifying code, update documentation in the same change. Stale docs are worse than no docs.

### Docs index

| File | Purpose | When to reference |
|---|---|---|
| `docs/PRODUCT_SENSE.md` | Vision, principles, core beliefs. The "why" tiebreaker. | When making product tradeoff decisions. |
| `docs/ARCHITECTURE.md` | Codebase structure, modules, dependency flow, data flow. | When navigating the codebase or adding modules. Start here to find which file to edit. |
| `docs/product-specs/index.md` | Product specs entry point — links to focused spec files. | When implementing any feature. Load the specific spec you need. |
| `docs/product-specs/core-concepts.md` | Weekly budget, flex slots, planning-first, overconsumption priority. | When working on the product model or budget logic. |
| `docs/product-specs/flows.md` | Plan week flow, recipe flow, shopping list flow — all phases. | When changing user-facing conversation flows. |
| `docs/product-specs/solver.md` | Budget solver algorithm, constraints, inputs/outputs. | When fixing budget math or allocation. |
| `docs/product-specs/data-models.md` | TypeScript interfaces, Supabase schema. | When changing data shapes or persistence. |
| `docs/product-specs/ui.md` | Telegram UI, keyboards, message formatting, voice. | When modifying buttons, menus, or display. |
| `docs/product-specs/recipes.md` | Recipe format, generation, scaling, structure system. | When working on recipes. |
| `docs/BACKLOG.md` | Current version scope + versioned feature roadmap. | When checking what's in/out of scope. |
| `docs/design-docs/index.md` | Catalog of significant design decisions. | When making or reviewing architectural decisions. |
| `docs/plans/` | Execution plans for multi-step changes. | When planning or executing multi-step work. |

When adding new docs, update this table. An unlisted doc is invisible to the agent.

### Docs maintenance rules

See `docs/plans/002-docs-organization-rules.md` for the full rules on how to organize and maintain docs.

### Tech stack

- TypeScript / Node.js
- Telegram Bot API (grammy)
- OpenAI API behind provider interface: GPT-5.4 (complex), GPT-5.4-mini (generation/reasoning), GPT-5.4-nano (classification/parsing), Whisper (STT). Mini and primary support reasoning modes: none, low, medium, high, xhigh.
- Supabase (state, plans) + markdown files (recipes)

### Coding conventions

- Keep files focused. One responsibility per file.
- Prefer explicit over clever. An agent reading this for the first time should understand it without surrounding context.
- When in doubt about a product decision, read `docs/PRODUCT_SENSE.md`.
- Telegram callback data has a 64-byte limit. Recipe slugs truncated via `truncateSlug()` in keyboards.ts; handlers use `findBySlugPrefix()` as fallback.
- Recipe slugs must be max 50 chars (enforced in the generator prompt).
- When modifying code that changes product behavior, update the relevant doc in the same commit. Stale docs actively mislead the next agent.

## Debug workflow

The primary development loop: user runs the bot, tests via Telegram, comes back to discuss issues and request changes.

### When the user reports an issue

1. **Read the end of `logs/debug.log` first.** Append-only, can grow large. Start from the last ~200 lines. Contains every Telegram message, AI call (full prompts/responses/tokens/duration), flow state transition, and QA validation result.
2. **Correlate with the log.** Tags: `[TG:IN]` / `[TG:OUT]` / `[AI:REQ]` / `[AI:RES]` / `[FLOW]` / `[QA]`. Find the relevant interaction.
3. **Diagnose from the log, then fix.** The log usually has enough context without asking for more details.

### Debug mode

`DEBUG=1 npm run dev` or `npm run dev:debug` — adds verbose console output and a one-line debug footer on Telegram messages showing models used and timing.
