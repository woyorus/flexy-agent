# Core Concepts

> Scope: The product model — weekly budget, flex slots, planning-first approach, overconsumption priority. See also: [solver.md](./solver.md) for the math, [flows.md](./flows.md) for user-facing interactions.

## Weekly calorie budget

The fundamental unit is the **week**, not the day. The user has a weekly calorie and protein target. Individual days can vary — what matters is the weekly total landing in the right ballpark.

- Weekly calories: daily target x 7 (e.g., 2,436 x 7 = 17,052)
- Weekly protein: daily target x 7 (e.g., 150 x 7 = 1,050g)

## Flex budget (replaces old "fun food" model)

The system allocates ~20% of weekly calories as a **flex pool**. This pool is split into two buckets:

1. **Flex slots** — planned meals where the calorie target is boosted above the normal meal-prep baseline. The extra calories come from the flex pool. Common uses: burger night, pizza, takeout. The plan-proposer suggests these automatically; the user approves or adjusts.

2. **Treat budget** — the remainder after flex slot bonuses. Spent freely on snacks/desserts throughout the week, not assigned to specific days.

```
flexBudget.totalPool = 20% of weekly calories
flexBudget.flexSlotCalories = sum of all flex slot bonuses
flexBudget.treatBudget = totalPool - flexSlotCalories
```

The treat budget is **derived as the honest remainder** after all planned meals are accounted for. Recipes keep their natural per-serving calories — the system does not shrink meals to inflate the treat pool.

## Planning-first

The system front-loads intelligence into the weekly planning session. Because meal preps are cooked in batches and can't be resized after cooking, the plan must be correct at cook time. Restaurant meals, flex slots, and variable days are accounted for **before** recipes are generated and portions are sized.

## Overconsumption priority: flex budget absorbs first

When budget pressure exists (e.g., a large restaurant estimate squeezes the budget), the solver reduces the **flex budget first**, not the healthy meal structure. The 80% healthy structure (meal preps, breakfasts) is the last thing to shrink.

## No food waste

All servings in a meal prep batch must be consumed. The solver uses actual per-serving calories from each recipe, so batch sizes are naturally correct.

## Recipes keep their natural macros

The solver does NOT force uniform calorie targets across all meals. Each recipe's actual per-serving macros are used. The treat budget is derived as whatever's left after planned meals are accounted for.

## Meal structure

- **Breakfast**: Fresh daily. Not meal-prepped. Can be **locked** as a repeating recipe (default). Locked breakfast uses structured components like lunch/dinner recipes.
- **Lunch**: Meal-prepped. Default 3 servings per batch (option for 2). One-pan/one-pot by default.
- **Dinner**: Meal-prepped. Default 3 servings per batch (option for 2). One-pan/one-pot by default.
- **Flex slots**: Replace a lunch or dinner slot. Calorie target = base + flex bonus. No specific food assigned.
- **Restaurant/social meals**: Replace a meal slot. Estimated at planning time.

## User profile (v0.0.3)

Single-user with hardcoded targets in `src/config.ts`:

```
Daily: 2,436 cal, 150g protein, 131g fat, 164g carbs
Weekly: 17,052 cal, 1,050g protein
Priority: calories > protein > fat > carbs
```

The product shows calories and protein. Fat and carbs are internal — used by the recipe generator for balanced meals, never shown to the user.

## Food profile

Shapes ingredient selection across all recipe generation and plan proposals. Hardcoded for single user (southern Spain) in `config.foodProfile`. Includes region, store access, ingredient preferences, and avoided items.

## Authentication (v0.0.3)

Single-user via hardcoded Telegram chat ID. Bot ignores all other messages.
