# Plan 001: Calorie Budget Redesign — Treat Headroom + Recipe Scaling

**Status:** Complete — all three phases implemented
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

This breaks the core product promise (../PRODUCT_SENSE.md): flexibility, fun foods, handling cravings, the system bending without breaking. If every calorie is locked into meal prep, there's nothing left for ice cream, a handful of nuts, or absorbing cooking imprecision.

Additionally, when v0.0.5 adds restaurant tracking and rebalancing, the system needs to scale down remaining meals to absorb overages. If meals are already at maximum size, there's no room to scale. See also: `docs/plans/003-flex-slot-redesign.md` for open problems with flex slots and rebalancing.

## Root Cause

Recipe generation targets are calculated as `(100% - 27% breakfast) / 2 = 36.5%` per meal. This allocates ALL non-breakfast calories to meal preps, leaving zero headroom by design.

## Proposed Solution

### 1. Protected treat budget as a design parameter

The treat budget is not "whatever's left" — it's a **protected allocation** that the solver reserves before sizing meals.

```
Daily target:     2,436 cal
Breakfast:          658 cal (27%)
Treat headroom:    ~122 cal (5%)     ← PROTECTED
Lunch + Dinner:  1,656 cal (68%)     ← what's left for meals
Per meal:          ~803 cal (typical week with 1 flex slot)
```

The weekly treat budget is `~5% of weekly calories = ~853 cal/week`. This gives:
- ~122 cal/day average
- Enough for 2-3 meaningful treat occasions per week (ice cream ~300, chocolate ~200)
- Not so large that it triggers overconsumption of ultra-processed foods
- Absorbs cooking imprecision (±50 cal/meal is normal)
- Provides buffer before v0.0.5 rebalancing exists

The 5% number is a config constant, not hardcoded in the solver. Can be tuned.

**Why 5% and not more or less:**
- 10% (1,705/week) → 5-6 treats, meals at ~742. Way too many treats, meals unsatisfying — a path to yo-yo dieting.
- 7% (1,194/week) → 3-4 treats, meals at ~779. Nice treat frequency but 12% meal drop risks compensatory snacking.
- **5% (853/week) → 2-3 treats, meals at ~803. Meals satisfying (only 10% below current 890), treats meaningful but not excessive.**

(All per-meal numbers assume 1 flex slot at 350 cal bonus, 14 total lunch/dinner slots.)

Prioritizing meal satisfaction over treat frequency prevents the yo-yo cycle: unsatisfying meals → compensatory snacking → guilt → restriction. 2-3 treats per week at ~300-400 cal is enough to prevent deprivation without triggering addictive patterns with ultra-processed foods.

### 2. Lower recipe generation targets

Change the recipe generation percentage from 36.5% to ~33% per lunch/dinner:

```
Current:  36.5% of 2,436 = 889 cal per meal
Proposed: 33.0% of 2,436 = 804 cal per meal
```

The fat/carb/protein split adjusts proportionally. The key change is in `targetsForMealType()` in `recipe-flow.ts`.

33% matches the solver's clean-week per-slot target (803 cal), so new recipes need almost no scaling in the most common scenario. The full budget split: 27% breakfast + 5% treat + 33% lunch + 33% dinner = 98%, with the remaining ~2% being the flex bonus (350/17,052).

**Important:** Existing recipes (867-908 cal) are NOT regenerated. They remain in the DB at their current levels. The solver scales them down at plan time via the recipe scaler. New recipes generated after this change will target ~804 cal.

### 3. Wire the recipe scaler into the plan flow

The scaler sub-agent (`recipe-scaler.ts`) exists but is never called. After the solver computes per-batch targets, each recipe is scaled:

1. Solver determines per-meal target (e.g., 803 cal for a clean week, 749 for a week with many events)
2. For each batch, the scaler adjusts the recipe's carb side to hit the target
3. The plan displays **scaled macros** per recipe (not base recipe macros)
4. The `WeeklyPlan.cookDays[].batches[]` stores `actualPerServing` and `scaledIngredients` (currently zeroed out — would be filled)

Shopping list will be reworked separately — not in scope for this plan.

The carb side is the primary lever (rice, pasta, potatoes). Protein and vegetables stay stable for satiety. This is already how the ingredient role system is designed to work.

### 4. Solver changes

The solver flow becomes:

```
1. weeklyTarget:           17,052
2. subtract breakfast:     -4,606
3. subtract events:        variable (meal-replacement events only)
4. subtract flex bonuses:  variable (~350 per flex slot)
5. subtract treat budget:  -853    (5% of weekly, config constant)
6. remainder → meal preps: distributed across batches
7. per-batch target:       remainder / total servings
8. scale each recipe to its batch target
```

The solver outputs per-batch targets with the actual calorie level for that week. These will vary week-to-week depending on events and flex slots:
- Clean week (no events, 1 flex slot): ~803 cal/meal
- Week with 1 restaurant dinner (1,000 cal): ~788 cal/meal
- Heavy event week (3+ large events): ~749 cal/meal (solver warns if below 650)

This is the system "bending" to accommodate real life — exactly what PRODUCT_SENSE.md requires.

## Math Validation

### Scenario A: Clean week (no events, 1 flex slot)

```
Weekly target:    17,052
Breakfast:        658 × 7 = 4,606
Treat budget:     853 (5%)
Flex bonus:       350 (1 flex slot)
Meal prep budget: 17,052 - 4,606 - 853 - 350 = 11,243
Slots:            7 lunches + 6 dinners + 1 flex dinner = 14
Per slot:         11,243 / 14 = 803 cal
Flex meal total:  803 + 350 = 1,153

Daily (clean day): 658 + 803 + 803 = 2,264 cal from meals
Weekly treats:     853 cal (~2-3 treats of ~300 cal, spent any day)
```

### Scenario B: Week with 1 restaurant dinner

```
Weekly target:    17,052
Breakfast:        4,606
Events:           1,000 (restaurant dinner — replaces 1 dinner slot)
Treat budget:     853
Flex bonus:       350
Meal prep budget: 17,052 - 4,606 - 1,000 - 853 - 350 = 10,243
Slots:            14 − 1 event = 13 (12 meal prep + 1 flex)
Per slot:         10,243 / 13 = 788 cal
Flex meal:        788 + 350 = 1,138

Daily (clean day): 658 + 788 + 788 = 2,234 cal from meals
Weekly treats:     853 cal (~2-3 treats of ~300 cal, spent any day)
```

Note: the restaurant dinner (1,000 cal) replaces one 788-cal slot — a net drain of 212 cal spread across remaining meals (803 → 788). Treat events (cookies at work, etc.) are NOT solver events — they're treat budget expenditure and don't affect the slot grid. See "Event semantics" below.

### Scaling example: Bolognese from 908 → 803 cal

```
Base recipe (908 cal):
  ground beef: 200g (protein) → stays 200g
  passata: 180g (base) → stays 180g
  vegetables: 98g total → stays 98g
  olive oil: 18g (fat) → 13g (-5g, -45 cal)
  rigatoni: 65g dry (carb) → 48g dry (-17g, -60 cal)
  seasonings → stay same

Scaled (~803 cal): protein preserved, carb reduced ~26%, fat trimmed slightly.
Less pasta than current but still a proper portion.
```

## Event Semantics

Two fundamentally different things happen outside meal prep. Only one affects the solver:

**Meal-replacement events** (restaurant dinners, eating at a friend's house):
- Replace a lunch or dinner slot entirely
- The solver subtracts their estimated calories and removes the slot from the grid
- Declared during the planning flow "events" step: "Any meals you'll eat out this week?"
- Affect meal prep sizing (fewer slots → budget redistributed)

**Treat events** (cookies at work, ice cream, a handful of nuts):
- Do NOT replace any meal slot — you still eat your three meals
- Funded by the treat budget (853 cal/week)
- NOT declared during planning — they're spontaneous
- No solver involvement; they're invisible to the slot grid
- In v0.0.5 tracking, reported as treat budget debits

Why the distinction matters: replacing an 800 cal protein-rich meal with 350 cal of cookies means under-eating, missing protein, and triggering psychological rebound. Treats are extras on top of meals, not substitutes.

## Implementation Steps

Three phases. Phase 1 and 2 can land independently. Phase 3 depends on the Plan Week feature.

### Phase 1: Config + Recipe Generation Target

Independent changes that take effect immediately for new recipe generation.

**Step 1a: `src/config.ts`** — add treat budget percentage

Add `treatBudgetPercent` inside `config.targets`, after `weekly`:

```typescript
targets: {
  daily: { ... },
  weekly: { ... },
  /** Protected treat budget as fraction of weekly calories. 5% = ~853 cal/week. */
  treatBudgetPercent: 0.05,
},
```

**Step 1b: `src/agents/recipe-flow.ts`** — lower generation target

In `targetsForMealType()`, change the lunch/dinner percentage:

```typescript
// Current (line ~108):
const remaining = 0.365; // each gets ~36.5%

// New:
const remaining = 0.33; // each gets ~33% (804 cal at 2,436 daily)
```

One-line change. All future recipes will target ~804 cal instead of ~889 cal.

**Verify:** `npx tsc --noEmit` passes. Generate a lunch recipe — targets should show ~804 cal.

### Phase 2: Solver + Types Rewrite

These changes are coupled — do them together in one commit.

**Step 2a: `src/solver/types.ts`** — clean up types

1. `RecipeRequest`: **remove** the `actualMacros?: Macros` field. The solver no longer uses per-recipe macros — it distributes evenly.

2. `SolverOutput.weeklyTotals`: simplify to match new model:
```typescript
weeklyTotals: {
  calories: number;
  protein: number;
  /** Protected treat budget — treatBudgetPercent of weekly calories */
  treatBudget: number;
  /** Sum of flex slot bonuses */
  flexSlotCalories: number;
};
```
Remove `funFoodPool` and `funFoodPercent` — these are leftovers from the 20% pool model.

**Step 2b: `src/models/types.ts`** — update WeeklyPlan.flexBudget

```typescript
flexBudget: {
  /** Protected treat budget — 5% of weekly calories */
  treatBudget: number;
  /** Sum of flex slot bonuses */
  flexSlotCalories: number;
  /** The flex slots themselves */
  flexSlots: FlexSlot[];
};
```

Remove `totalPool` — it was `treatBudget + flexSlotCalories`, which is no longer a meaningful concept. The treat budget is a protected allocation, not a remainder from a shared pool.

**Step 2c: `src/solver/solver.ts`** — rewrite `solve()`

The core algorithmic change. The new `solve()` function:

```
1. weeklyBreakfastCal   = breakfast.caloriesPerDay × 7
2. totalEventsCal       = sum of event estimated calories
3. totalFlexBonus       = sum of flex slot bonuses
4. treatBudget          = weeklyTargets.calories × config.targets.treatBudgetPercent  ← NEW
5. mealPrepBudget       = weeklyTargets - breakfast - events - flexBonuses - treatBudget
6. totalSlots           = sum of recipe servings + count of flex slots
7. perSlotCal           = mealPrepBudget / totalSlots  ← UNIFORM
8. perSlotProtein       = (weeklyProtein - breakfastProtein - eventProtein) / totalSlots
9. All batch targets get { calories: perSlotCal, protein: perSlotProtein }
10. Clamp, build daily breakdown, validate
```

What to **remove** from the current solver:
- Lines 74-83: the `recipesWithMacros` / `avgRecipeCal` / `avgRecipeProtein` block. No longer needed — we don't use per-recipe macros.
- Lines 85-95: the batch target creation that uses `req.actualMacros?.calories ?? avgRecipeCal`. Replace with uniform `perSlotCal`.
- Lines 127-141: the "derive treat budget as remainder" block (`Math.max(0, weeklyTargets - plannedCal)`). Replace with protected upfront calculation.
- The `MIN_TREAT_BUDGET_WARNING` constant and its check. The treat budget is now fixed (not derived), so it never gets "tight" — events squeeze meal prep, not treats.
- The `funFoodPool` and `funFoodPercent` computations.

What **stays the same**:
- `getWeekDays()`, `groupByDay()` helpers
- `buildDailyBreakdown()` structure (but flex base calories change from `avgRecipeCal` to `perSlotCal`)
- `buildCookingSchedule()` — unchanged
- Min/max per-slot clamping (400-1000 cal)
- Weekly tolerance validation (±3%)

Update `buildDailyBreakdown()`:
- The `flexBaseCal` / `flexBaseProtein` parameters currently use the average recipe calories. Change to `perSlotCal` / `perSlotProtein` — flex slots get the same base as all other slots, plus their bonus.

Add a new warning:
```typescript
if (perSlotCal < 650) {
  warnings.push(`Per-meal target ${perSlotCal} cal is very low. Consider fewer events or a lower treat budget.`);
}
```

**Verify:** `npx tsc --noEmit` passes. Manually test the solver with a clean-week input — per-slot should be ~803 cal. Test with 1 restaurant event — per-slot should be ~788 cal.

### Phase 3: Wire Recipe Scaler (depends on Plan Week feature)

This phase happens when `src/agents/plan-flow.ts` is created as part of the Plan Week implementation.

**In plan-flow.ts**, after the solver runs and returns batch targets:

```typescript
for (const batch of solverOutput.batchTargets) {
  if (batch.recipeSlug) {
    const recipe = await db.findBySlug(batch.recipeSlug);
    const scaled = await scaleRecipe({
      recipe,
      targetCalories: batch.targetPerServing.calories,
      targetProtein: batch.targetPerServing.protein,
      servings: batch.servings,
    }, llm);
    // Fill in the WeeklyPlan batch fields
    planBatch.actualPerServing = scaled.actualPerServing;
    planBatch.scaledIngredients = scaled.scaledIngredients;
  }
}
```

The scaler (`src/agents/recipe-scaler.ts`) already exists and works. It adjusts carb/fat ingredients to hit the target while preserving protein. The only work here is calling it at the right point in the plan flow.

**Verify:** Generate a full plan. Each batch should have `actualPerServing` close to the solver's per-slot target. The `scaledIngredients` should have adjusted carb amounts.

## What This Does NOT Change

- **Existing recipes stay in the DB as-is.** They are not regenerated. The scaler handles the difference at plan time.
- **The plan-proposer sub-agent.** It still picks recipes based on variety. The calorie adjustment happens after, in the solver + scaler.
- **The flex slot mechanism.** Flex slots still work the same — a meal with a calorie bonus.
- **The recipe generator prompt structure.** Only the calorie/macro targets change, not the prompt instructions.

## Risks

- **Scaling accuracy.** The recipe scaler is an LLM call, not deterministic math. If it miscalculates the scaled macros, the weekly total drifts. Mitigation: QA gate validates scaled recipes.
- **Meal satisfaction at ~803 cal.** This is 10% below the current ~890. Protein stays the same (satiety driver), carb sides shrink ~26% (e.g., rigatoni 65g → 48g dry). Noticeable but manageable. The percentage is a config constant — easy to tune after real-world testing.
- **LLM cost.** The scaler adds 1 LLM call per batch (typically 4-5 per plan). At mini model with low reasoning, ~$0.01-0.02 per plan. Acceptable.

## Decisions

1. **Plan display shows scaled macros per recipe** (not the uniform solver target). The "Current Plan View" feature (backlog) will implement this — not in scope here.

## Related

- `docs/plans/003-flex-slot-redesign.md` — Open problems with flex slots, restaurant interaction, and rebalancing (parked until v0.0.5)
