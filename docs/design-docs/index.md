# Design Docs Index

> Scope: Catalog of significant design decisions. See also: [product-specs/](../product-specs/) for current behavior, [PRODUCT_SENSE.md](../PRODUCT_SENSE.md) for principles.

## When to create a design doc

Create a design doc when a change:
- Alters how a core system works (solver, flows, data model)
- Involves a non-obvious tradeoff worth recording for future context
- Affects multiple modules or introduces a new architectural pattern

A design doc captures: the problem, options considered, the decision, and why. It's a snapshot of reasoning at decision time — useful when a future agent asks "why is it done this way?"

## Format

```markdown
# [Title]

> Status: proposed | accepted | superseded
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
