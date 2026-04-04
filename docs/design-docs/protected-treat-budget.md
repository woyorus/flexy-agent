# Protected Treat Budget + Uniform Meal Slots

> Status: accepted
> Date: 2026-04-04
> Full history: [plans/completed/001-calorie-budget-redesign.md](../plans/completed/001-calorie-budget-redesign.md)

## Problem

In the original solver, recipes kept their natural per-serving macros (867–908 cal), and the treat budget was **derived** as the weekly remainder after all planned meals. This meant:

- Meal preps consumed ~99% of the daily calorie budget, leaving ~2 cal/day for treats
- Zero buffer for life flexibility, cooking imprecision, or spontaneous snacks
- When v0.0.5 tracking + rebalancing arrives, there would be no headroom to absorb restaurant overages

This broke the core product promise of "structure with flexibility." Every calorie was locked into meal prep by design.

## Options considered

1. **Keep derived treat budget, lower meal prep targets globally** — still no guarantee treats stay protected when events squeeze the budget.
2. **Protect treat budget as a fixed percentage, keep recipes at natural macros** — treats safe, but meals at their 867–908 cal baseline leave no room for the protected buffer.
3. **Protect treat budget + distribute meal prep budget uniformly across all slots, scale recipes to hit the uniform target** — treats safe, meals predictable, scaler absorbs recipe-level variance.

## Decision

Option 3. The solver reserves `config.planning.treatBudgetPercent × weeklyCalories` (5% = ~853 cal/week) **upfront**, then distributes the remaining meal prep budget uniformly across all non-event, non-flex lunch/dinner slots. At plan approval, the recipe scaler (`src/agents/recipe-scaler.ts`) adjusts each recipe's ingredients to hit its assigned per-slot target within ±20 cal, preserving protein precisely.

Key constants in `config.planning`:
- `treatBudgetPercent: 0.05` — 2-3 treats per week of ~300-400 cal each
- `flexSlotsPerWeek: 1` — exactly one flex meal (additional flex slots erode every meal prep slot by ~25 cal)
- `scalerCalorieTolerance: 20` — ±20 cal lets the scaler pick clean ingredient amounts

## Why

**Why 5% treat budget and not 7-10%:** With 6 recipes, 1 flex slot, and no events, per-slot drops to ~803 cal at 5%, ~779 cal at 7%, ~742 cal at 10%. 803 is only 10% below the prior 890 cal baseline — noticeable but acceptable. 779 is 12% below and risks compensatory snacking. Higher values cross into yo-yo territory. Prioritizing meal satisfaction over treat frequency prevents the "unsatisfying meals → snacking → guilt → restriction" cycle.

**Why protect the treat budget upfront instead of deriving it:** A derived treat budget silently shrinks when events or heavier recipes consume more of the weekly total. The user never knows when their flexibility buffer has evaporated. A protected allocation makes the buffer reliable — events squeeze meal prep slots instead.

**Why uniform per-slot targets instead of keeping natural recipe macros:** With natural macros, weekly totals drift based on which recipes land in a given week. Uniform targets make every week predictable: clean weeks hit 803 cal/meal, event weeks scale down together. The recipe scaler absorbs the variance at the recipe level — protein stays precise, carbs and fat flex to fit.

**Why ±20 cal scaler tolerance:** LLM macro estimates are ±10% by nature — false precision beyond ~20 cal is illusory. Giving the scaler a range lets it pick clean amounts (45g dry pasta, half teaspoons) instead of chasing exact numbers with awkward quantities. Natural variance across meals absorbs into the treat budget and feels more human.

**Why exactly 1 flex slot per week:** Each flex slot's 350 cal bonus is divided across all 14 meal prep slots, costing ~25 cal per meal. Two flex slots at 5% treat yields meals at ~778 cal — functionally equivalent to 7% treat with 1 flex. The user explicitly chose meal satisfaction over flex frequency. Future versions may rotate (e.g., one 2-flex week per month) via the same config knob.

## Relationship to other systems

- **Solver** (`src/solver/solver.ts`) — implements the protected allocation + uniform distribution.
- **Recipe scaler** (`src/agents/recipe-scaler.ts`) — runs at plan approval to hit solver targets. New in this design; previously existed but was never called.
- **Plan-proposer** (`src/agents/plan-proposer.ts`) — enforces `flexSlotsPerWeek` with retry, prefers 3-serving batches to minimize cooking sessions.
- **Recipe generation targets** (`src/agents/recipe-flow.ts` `targetsForMealType`) — new recipes target 33% of daily calories each for lunch/dinner (~804 cal), which matches the typical clean-week solver target so the scaler barely needs to touch new recipes.
- **QA gate** — enforces Atwater macro/calorie consistency (`calories = 4P + 4C + 9F` within ±5%) in both generation correction loop and scaler retry loop.
- **Event semantics** — only meal-replacement events subtract a slot in the solver. Treat events (cookies at work, drinks) come from the treat budget without touching the slot grid. See `plans/completed/004-event-type-classification.md`.
