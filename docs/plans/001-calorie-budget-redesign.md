# Plan 001: Calorie Budget Redesign — Treat Headroom + Recipe Scaling

**Status:** Draft — awaiting validation
**Date:** 2026-04-03
**Affects:** solver, recipe generation targets, plan flow, recipe scaler integration

---

## Problem

The current system has no room for treats or life flexibility. Recipes consume ~100% of the daily calorie budget:

```
Daily target:     2,436 cal
Breakfast:          658 cal (27%)
Lunch:             ~888 cal (36.5%)   ← recipe generation target
Dinner:            ~888 cal (36.5%)   ← recipe generation target
                  ─────
Total from meals: 2,434 cal → 99.9% of daily budget
Treat headroom:     ~2 cal/day → effectively zero
```

This breaks the core product promise (PROJECT.md): flexibility, fun foods, handling cravings, the system bending without breaking. If every calorie is locked into meal prep, there's nothing left for ice cream, a handful of nuts, or absorbing cooking imprecision.

Additionally, when v0.0.2 adds restaurant tracking, the system needs to scale down remaining meals to absorb overages. If meals are already at maximum size, there's no room to scale.

## Root Cause

Recipe generation targets are calculated as `(100% - 27% breakfast) / 2 = 36.5%` per meal. This allocates ALL non-breakfast calories to meal preps, leaving zero headroom by design.

## Proposed Solution

### 1. Protected treat budget as a design parameter

The treat budget is not "whatever's left" — it's a **protected allocation** that the solver reserves before sizing meals.

```
Daily target:     2,436 cal
Breakfast:          658 cal (27%)
Treat headroom:    ~243 cal (10%)    ← PROTECTED
Lunch + Dinner:  1,535 cal (63%)     ← what's left for meals
Per meal:          ~768 cal
```

The weekly treat budget is `~10% of weekly calories = ~1,705 cal/week`. This gives:
- ~243 cal/day average
- Enough for 4-5 treat occasions per week (ice cream ~300, chocolate ~200, handful of nuts ~180)
- Absorbs cooking imprecision (±50 cal/meal is normal)
- Provides buffer before v0.0.2 rebalancing exists

The 10% number is a config constant, not hardcoded in the solver. Can be tuned.

### 2. Lower recipe generation targets

Change the recipe generation percentage from 36.5% to ~31.5% per lunch/dinner:

```
Current:  36.5% of 2,436 = 889 cal per meal
Proposed: 31.5% of 2,436 = 767 cal per meal
```

The fat/carb/protein split adjusts proportionally. The key change is in `targetsForMealType()` in `recipe-flow.ts`.

**Important:** Existing recipes (867-908 cal) are NOT regenerated. They remain in the DB at their current levels. The solver scales them down at plan time via the recipe scaler. New recipes generated after this change will target ~767 cal.

### 3. Wire the recipe scaler into the plan flow

The scaler sub-agent (`recipe-scaler.ts`) exists but is never called. After the solver computes per-batch targets, each recipe is scaled:

1. Solver determines per-meal target (e.g., 780 cal for a clean week, 720 for a week with many events)
2. For each batch, the scaler adjusts the recipe's carb side to hit the target
3. The plan displays **scaled macros** per recipe (not base recipe macros)
4. The shopping list uses **scaled ingredient amounts**
5. The `WeeklyPlan.cookDays[].batches[]` stores `actualPerServing` and `scaledIngredients` (currently zeroed out — would be filled)

The carb side is the primary lever (rice, pasta, potatoes). Protein and vegetables stay stable for satiety. This is already how the ingredient role system is designed to work.

### 4. Solver changes

The solver flow becomes:

```
1. weeklyTarget:           17,052
2. subtract breakfast:     -4,606
3. subtract events:        variable
4. subtract flex bonuses:  variable (~350 per flex slot)
5. subtract treat budget:  -1,705  (10% of weekly, config constant)
6. remainder → meal preps: distributed across batches
7. per-batch target:       remainder / total servings
8. scale each recipe to its batch target
```

The solver outputs per-batch targets with the actual calorie level for that week. These will vary week-to-week depending on events and flex slots:
- Clean week (no events): ~780 cal/meal
- Week with 1 restaurant dinner: ~750 cal/meal
- Heavy event week: ~700 cal/meal (solver warns if below 650)

This is the system "bending" to accommodate real life — exactly what PROJECT.md requires.

## Math Validation

### Scenario A: Clean week (no events, 1 flex slot)

```
Weekly target:    17,052
Breakfast:        658 × 7 = 4,606
Treat budget:     1,705 (10%)
Flex bonus:       350 (1 flex slot)
Meal prep budget: 17,052 - 4,606 - 1,705 - 350 = 10,391
Servings:         12 batch + 1 flex base = 13 slots
Per slot:         10,391 / 13 = 799 cal
Flex meal total:  799 + 350 = 1,149

Daily (clean day): 658 + 799 + 799 = 2,256 cal
Treat room:        2,436 - 2,256 = 180 cal/day (from treat pool)
Weekly treats:     1,705 cal (~4-5 treat occasions)
```

### Scenario B: Week with restaurant dinner + cookies event

```
Weekly target:    17,052
Breakfast:        4,606
Events:           1,000 (restaurant) + 350 (cookies) = 1,350
Treat budget:     1,705
Flex bonus:       350
Meal prep budget: 17,052 - 4,606 - 1,350 - 1,705 - 350 = 9,041
Servings:         10 batch + 1 flex = 11 slots (2 slots taken by events)
Per slot:         9,041 / 11 = 822 cal
Flex meal:        822 + 350 = 1,172

Daily (clean day): 658 + 822 + 822 = 2,302 cal
Treat room:        134 cal/day
Weekly treats:     1,705 cal
```

### Scaling example: Bolognese from 908 → 799 cal

```
Base recipe (908 cal):
  ground beef: 200g (protein) → stays 200g
  passata: 180g (base) → stays 180g
  vegetables: 98g total → stays 98g
  olive oil: 18g (fat) → 14g (-4g, -36 cal)
  rigatoni: 65g dry (carb) → 48g dry (-17g, -60 cal)
  seasonings → stay same

Scaled (799 cal): protein preserved, carb reduced, fat trimmed slightly.
The meal looks and tastes the same — just a bit less pasta on the plate.
```

## Files to Change

| File | Change |
|---|---|
| `src/config.ts` | Add `treatBudgetPercent: 0.10` to targets |
| `src/agents/recipe-flow.ts` | Change `targetsForMealType()`: lunch/dinner from 36.5% to 31.5% |
| `src/solver/solver.ts` | Use protected treat budget (config %) before distributing to meals. Return even per-slot target based on remaining budget. |
| `src/agents/plan-flow.ts` | After solver runs, call recipe scaler for each batch. Fill `actualPerServing` and `scaledIngredients` on the WeeklyPlan. |
| `src/agents/plan-flow.ts` | Update `buildSolverInput` — no longer needs `actualMacros` on RecipeRequest (solver distributes evenly, scaler handles the rest) |
| `src/solver/types.ts` | Can remove `actualMacros?` from RecipeRequest (added in previous iteration, no longer needed) |
| `src/telegram/formatters.ts` | Plan display shows scaled per-recipe macros (from `actualPerServing`), not uniform solver target |

## What This Does NOT Change

- **Existing recipes stay in the DB as-is.** They are not regenerated. The scaler handles the difference at plan time.
- **The plan-proposer sub-agent.** It still picks recipes based on variety. The calorie adjustment happens after, in the solver + scaler.
- **The flex slot mechanism.** Flex slots still work the same — a meal with a calorie bonus.
- **The recipe generator prompt structure.** Only the calorie/macro targets change, not the prompt instructions.

## Risks

- **Scaling accuracy.** The recipe scaler is an LLM call, not deterministic math. If it miscalculates the scaled macros, the weekly total drifts. Mitigation: QA gate validates scaled recipes.
- **Meal satisfaction at ~780 cal.** This is lower than the current ~890. Subjective — needs real-world testing. The protein stays the same (satiety driver), only carb side shrinks. Mitigation: if 780 feels too low, bump treat budget from 10% to 8%.
- **LLM cost.** The scaler adds 1 LLM call per batch (typically 4-5 per plan). At mini model with low reasoning, ~$0.01-0.02 per plan. Acceptable.

## Open Questions

1. **Should the treat budget be 10% or 8%?** 10% = 1,705 cal/week, meals at ~780. 8% = 1,364 cal/week, meals at ~810. Both are viable. Suggest starting at 10% and adjusting based on how satisfying the meals feel.

2. **Should the plan display show scaled macros per recipe, or just the uniform target?** Scaled is more honest (different recipes scale slightly differently), but the uniform target is simpler. Recommend: show scaled macros per recipe.
