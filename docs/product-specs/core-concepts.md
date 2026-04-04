# Core Concepts

> Scope: The product model — weekly budget, flex slots, planning-first approach, overconsumption priority. See also: [solver.md](./solver.md) for the math, [flows.md](./flows.md) for user-facing interactions.

## Weekly calorie budget

The fundamental unit is the **week**, not the day. The user has a weekly calorie and protein target. Individual days can vary — what matters is the weekly total landing in the right ballpark.

- Weekly calories: daily target x 7 (e.g., 2,436 x 7 = 17,052)
- Weekly protein: daily target x 7 (e.g., 150 x 7 = 1,050g)

## Flex budget — protected treat + flex slots

The flex budget has two **independent** allocations (not a shared pool):

1. **Treat budget** — a **protected 5% of weekly calories** (`config.planning.treatBudgetPercent = 0.05`, ~853 cal/week). Reserved upfront by the solver before sizing meal prep slots. Spent freely on 2-3 treat occasions per week (ice cream, cookies, chocolate). Not assigned to specific days.

2. **Flex slots** — planned meals where the calorie target is boosted above the normal meal-prep baseline by ~350 cal. Common uses: burger night, pizza, takeout. Currently hard-constrained to **exactly 1 per week** (`config.planning.flexSlotsPerWeek = 1`) — additional flex slots erode every meal prep slot by ~25 cal.

```
flexBudget.treatBudget = weeklyCalories × treatBudgetPercent  (protected, ~853 cal)
flexBudget.flexSlotCalories = sum of all flex slot bonuses     (exactly 1 × 350)
flexBudget.flexSlots = [FlexSlot]
```

The treat budget is **not** a remainder. It's a fixed allocation reserved before any meal sizing happens. This prevents meals from shrinking unpredictably and gives the user a reliable buffer for spontaneous eating.

### Why 5% treat budget

At 5% the user gets 2-3 meaningful treats per week (~300-400 cal each) while meal prep slots stay at ~803 cal — only 10% below the prior ~890 cal baseline. Higher percentages (7-10%) push meals into territory where compensatory snacking and yo-yo patterns become a risk. The tradeoff is encoded in `config.planning.treatBudgetPercent` for future tuning. See `docs/plans/completed/001-calorie-budget-redesign.md`.

## Planning-first

The system front-loads intelligence into the weekly planning session. Because meal preps are cooked in batches and can't be resized after cooking, the plan must be correct at cook time. Restaurant meals, flex slots, and variable days are accounted for **before** recipes are generated and portions are sized.

## Overconsumption priority: meals absorb budget pressure, treats stay protected

When budget pressure exists (e.g., a large restaurant estimate squeezes the budget), the **meal prep slots shrink** to absorb it. The treat budget stays fixed — it's the flexibility buffer that makes the system feel livable. The solver warns if per-slot calories drop below 650.

## No food waste

All servings in a meal prep batch must be consumed. Batches are 2-3 servings with consecutive day ranges, and the solver counts every slot.

## Uniform meal prep slots, recipes scaled to match

The solver distributes the meal prep budget (weekly − breakfast − events − flex bonuses − treat budget) evenly across all non-event, non-flex lunch/dinner slots. Every batch gets the **same** per-serving calorie target. At plan approval time, the **recipe scaler** (`src/agents/recipe-scaler.ts`) adjusts each recipe's ingredients to hit that target within a ±20 cal tolerance (so it can pick clean amounts like 45g dry pasta instead of chasing 47g). Protein stays precise during scaling — carbs and fat flex to balance the total.

## Event semantics: meal replacement vs treat

Events are classified into two kinds:

- **Meal-replacement events** (restaurant dinners, dinner at a friend's house) — replace a lunch or dinner slot. The solver subtracts their estimated calories and removes the slot from the meal prep grid.
- **Treat events** (cookies at work, birthday cake, drinks at happy hour) — do NOT replace a meal slot. The user still eats their regular meals; the extras are funded by the treat budget. Treats are not stored as events in the plan.

The event parser LLM classifies incoming descriptions. Only meal replacements get added to `state.events`; treats get explained ("your treat budget covers it") and discarded. See `docs/plans/completed/004-event-type-classification.md` for rationale.

## Meal structure

- **Breakfast**: Fresh daily. Not meal-prepped. Can be **locked** as a repeating recipe (default). Locked breakfast uses structured components like lunch/dinner recipes.
- **Lunch**: Meal-prepped. Plan-proposer prefers 3-serving batches (minimizes cooking); uses 2-serving batches to fine-tune slot coverage. One-pan/one-pot by default.
- **Dinner**: Meal-prepped. Same batch rules as lunch.
- **Flex slots**: Replace one lunch or dinner slot per week. Calorie target = uniform per-slot base + flex bonus (~350 cal). No specific food assigned.
- **Restaurant / meal-replacement events**: Replace a meal slot. Estimated at planning time.
- **Treat events**: Not in the slot grid. Funded by the protected treat budget.

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
