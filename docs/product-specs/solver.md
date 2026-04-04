# Budget Solver

> Scope: The deterministic budget allocation algorithm. No LLM involved. See also: [core-concepts.md](./core-concepts.md) for the product model, [data-models.md](./data-models.md) for input/output types.

Source: `src/solver/solver.ts`, `src/solver/types.ts`

## Algorithm

1. **Allocate breakfast** — If locked, subtract (breakfast cal x 7) from weekly budget. Fixed.
2. **Allocate events** — Sum restaurant meal estimates.
3. **Sum flex slot bonuses** — Total extra calories drawn from the flex pool.
4. **Lay out the week grid** — Extract all days from recipe requests + flex slots.
5. **Create batch targets using real recipe macros** — Each recipe keeps its natural per-serving calories. For recipes without known macros (newly generated), use the average of known ones. Fallback: 36.5% of daily calories.
6. **Balance** — Clamp any batch target to min 400 / max 1000 cal per serving.
7. **Derive treat budget** — `weeklyTarget - totalPlannedCalories`. This is the honest remainder, not a fixed reserve.
8. **Verify** — Weekly calories within +/-3% of target. Protein meets minimum (97%).

### Key difference from original spec

The original spec distributed calories evenly across meal-prep slots. The current solver uses **actual per-serving macros** from each recipe. Recipes keep their natural calories — no forced scaling to a uniform target. The treat budget absorbs the variance as the leftover.

## Inputs (`SolverInput`)

```typescript
{
  weeklyTargets: { calories, protein },
  events: MealEvent[],
  flexSlots: FlexSlot[],        // replaces the old funFoods: FunFoodItem[]
  mealPrepPreferences: {
    recipes: RecipeRequest[],   // each has optional actualMacros from the recipe DB
  },
  breakfast: { locked, recipeSlug?, caloriesPerDay, proteinPerDay },
}
```

## Outputs (`SolverOutput`)

```typescript
{
  isValid: boolean,
  weeklyTotals: {
    calories, protein,
    funFoodPool,              // flex bonuses + treat budget
    flexSlotCalories,         // sum of all flex bonuses
    treatBudget,              // funFoodPool - flexSlotCalories
    funFoodPercent,           // funFoodPool as % of weekly calories
  },
  dailyBreakdown: DailyBreakdown[],   // per-day calories with sources
  batchTargets: BatchTarget[],         // per-batch calorie/protein targets
  cookingSchedule: CookingScheduleDay[], // when to cook what
  warnings: string[],
}
```

## Constraints (enforced)

| Constraint | Value | Type |
|---|---|---|
| Min meal calories | 400 cal | Hard (clamped) |
| Max meal calories | 1000 cal (+ flex bonus for flex slots) | Hard (clamped) |
| Weekly calorie tolerance | +/-3% | Hard (isValid = false) |
| Weekly protein minimum | 97% of target | Hard (isValid = false) |
| Treat budget warning | < 300 cal/week | Soft (warning) |
| Fun food pool > 15% | Informational | Soft (warning — usually means unresolved gaps) |

## Cooking schedule

Strategy: cook each batch the day before the first eating day. Groups batches that cook on the same day.

## QA gate (`src/qa/validators/plan.ts`)

Validates solver output before the plan is shown to the user. Checks all hard constraints above, plus:
- Cooking days must be before eating days
- Every day must have lunch + dinner covered (batch, event, or flex slot)
- Flex slots can exceed MAX_MEAL_CAL by their flex bonus amount

When validation fails, the plan flow logs warnings but still presents the plan (the solver output is deterministic and self-consistent — validation catches edge cases).
