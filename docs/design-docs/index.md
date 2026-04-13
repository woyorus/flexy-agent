# Design Docs Index

> Scope: Catalog of significant design decisions. See also: [product-specs/](../product-specs/) for current behavior, [PRODUCT_SENSE.md](../PRODUCT_SENSE.md) for principles, [proposals/](./proposals/) for in-progress design proposals.

## How design docs are created

Design docs are promoted from **design proposals**. The flow:

1. A product/UX change starts as a **design proposal** in `proposals/` — describing the experience, not the code.
2. After discussion and approval, the proposal is promoted to a **design doc** here.
3. The design doc becomes the source of truth for the implementation plan.

See [FEATURE-LIFECYCLE.md](../FEATURE-LIFECYCLE.md) for the full process.

## When to create a design doc directly (without a proposal)

For purely technical/architectural decisions that don't change the user experience — internal refactors, data model changes, infrastructure decisions. These skip the proposal stage because there's no UX to design. They still capture the tradeoff reasoning.

## Format

```markdown
# [Title]

> Status: accepted | superseded
> Date: YYYY-MM-DD

## Problem
## Options considered
## Decision
## Why
```

## Catalog

| Doc | Status | Summary |
|---|---|---|
| [protected-treat-budget.md](./protected-treat-budget.md) | accepted | Protected treat budget (5% of weekly, reserved upfront) + uniform meal prep slots + recipe scaler to hit them. Replaces the earlier "recipes keep natural macros, treat budget is remainder" model. |
| [test-harness-architecture.md](./test-harness-architecture.md) | accepted | Five-layer scenario harness: `BotCore` extraction, `StateStoreLike`, `FixtureLLMProvider` with per-hash queuing, scenario authoring API, `node:test` runner + custom generate CLI. Gives the agent a closed feedback loop with fixture-replayed LLM calls and no network on replay. |
| [rolling-horizons-and-first-class-batches.md](./rolling-horizons-and-first-class-batches.md) | accepted | Rolling 7-day horizons replace the Mon-Sun weekly grid. Batches are first-class Supabase entities that span horizon boundaries. Carry-over via pre-committed slots with frozen macros. Save-before-destroy replan flow. Client-side write ordering. |
| [001-upcoming-plan-visibility.md](./001-upcoming-plan-visibility.md) | landed | Confirmed plans with future start dates are fully visible across all surfaces (Next Action, Week Overview, Shopping List, Recipe List). Same screens, no special view — just a new `upcoming` lifecycle state and a `getVisiblePlanSession()` policy query. |
| [002-plans-that-survive-real-life.md](./002-plans-that-survive-real-life.md) | landed | Re-proposer agent replaces all deterministic mutation handlers. Single LLM call for any plan adjustment (flex moves, recipe swaps, event add/remove). Fridge-life batches, proposal validator, change summaries. Implemented by Plan 024 + Plan 025. |
| [005-honest-past-logging.md](./005-honest-past-logging.md) | accepted | Retroactive deviation reports ("I ate out Monday") push the affected batch forward in time, cascade downstream, and absorb a flex slot if the cascade reaches one; cascades that exceed the horizon spill into next horizon as pre-committed cook days. Current-horizon groceries and batch content are sacred — only timing mutates. Adds "planning not tracking" corollary to PRODUCT_SENSE. v0.0.5+ adds calorie estimation and budget absorption priority (flex → treat → teach). |
