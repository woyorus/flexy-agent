# Product Specs Index

> Scope: Entry point for all product specifications. Load this to find which spec file covers your area. See also: [ARCHITECTURE.md](../ARCHITECTURE.md) for code structure, [PRODUCT_SENSE.md](../PRODUCT_SENSE.md) for the "why."

Flexie is an AI agent that helps users lose weight by managing a weekly calorie budget with built-in flexibility for fun foods, restaurants, and real life. It is planning-first, not tracking-first. The core product is the **agent harness** — state management, budget solver, recipe database, and conversational flows. Telegram is the UI.

## Adding a new spec

Create a new file when a new product domain emerges that doesn't fit any existing spec, or when an existing spec exceeds ~300 lines. Name it `<domain>.md`, start with a scope line, add it to the table below and to the docs index in CLAUDE.md — same commit.

Specs describe current behavior, not aspirational design. Update when code changes — same commit.

## Spec files

| File | Covers | Load when |
|---|---|---|
| [core-concepts.md](./core-concepts.md) | Weekly budget, flex slots, planning-first, overconsumption priority, no-waste rule | Understanding the product model or budget logic |
| [flows.md](./flows.md) | Plan week flow, recipe generation flow, shopping list flow — all phases and handlers | Changing user-facing conversation flows |
| [solver.md](./solver.md) | Budget solver algorithm, constraints, inputs/outputs | Fixing budget math or allocation |
| [data-models.md](./data-models.md) | TypeScript interfaces, recipe format, Supabase schema | Changing data shapes or persistence |
| [ui.md](./ui.md) | Telegram UI, keyboards, message formatting, voice input | Modifying buttons, menus, or display |
| [recipes.md](./recipes.md) | Recipe format, generation constraints, scaling, meal types, structure | Working on recipe generation, parsing, or storage |
| [testing.md](./testing.md) | Scenario harness, fixture replay, `npm test`, authoring new scenarios, generate mode | Running tests, writing a new scenario, updating a stale recording |
