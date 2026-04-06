# Budget Solver

> Scope: The deterministic budget allocation algorithm. No LLM involved. See also: [core-concepts.md](./core-concepts.md) for the product model, [data-models.md](./data-models.md) for input/output types.

Source: `src/solver/solver.ts`, `src/solver/types.ts`

## Algorithm

The solver reserves a protected treat budget upfront, subtracts any pre-committed slot calories (carry-over from prior sessions), then distributes the remaining meal prep budget **uniformly** across all new meal prep slots. At plan approval time the recipe scaler adjusts each recipe's ingredients to hit its assigned per-slot target.

1. **Allocate breakfast** — `weeklyBreakfastCal = breakfast.caloriesPerDay × 7`. Fixed.
2. **Allocate meal-replacement events** — sum of restaurant event calories. Treat events are NOT solver inputs (they come from the treat budget).
3. **Sum flex slot bonuses** — `totalFlexBonus = sum of flexSlots[].flexBonus` (350 each, 1 slot per week).
4. **Protect treat budget** — `treatBudget = weeklyTargets.calories × config.planning.treatBudgetPercent` (5%, ~853 cal/week). Reserved upfront, never squeezed by events.
5. **Subtract pre-committed slots** — `preCommittedCal = sum of carriedOverSlots[].calories`. These are frozen macros from prior sessions' batches whose eating days overlap the current horizon.
6. **Compute meal prep budget** — `mealPrepBudget = weekly − breakfast − events − flexBonuses − treatBudget − preCommittedCal`.
7. **Count slots** — `totalSlots = sum of new recipe servings + flex slot count`. Servings here means in-horizon eating occasions only — overflow days are invisible to the solver (Plan 010). Pre-committed slots are NOT counted (already subtracted).
8. **Distribute uniformly** — `perSlotCal = mealPrepBudget / totalSlots`. Every new batch gets the same target. Protein follows the same pattern.
9. **Clamp** — Any batch target below `MIN_MEAL_CAL` (400) or above `MAX_MEAL_CAL` (1000) is clamped with a warning.
10. **Build daily breakdown** — For each day in `horizonDays`, sources are: event > flex slot > pre-committed slot (frozen macros) > new batch.
11. **Verify** — Weekly calories within ±3% of target (after adding back treat budget). Protein meets 97% of target. Warns if perSlotCal drops below 650 cal.

The **recipe scaler** runs at plan approval time (in `buildNewPlanSession`), not inside the solver. Each batch is scaled to its assigned `targetPerServing.calories` within a ±20 cal tolerance (configured via `config.planning.scalerCalorieTolerance`). This lets recipes pick clean ingredient amounts (45g dry pasta rather than 47g) while staying within the solver's weekly math.

## Inputs (`SolverInput`)

```typescript
{
  weeklyTargets: { calories, protein },
  events: MealEvent[],            // meal-replacement events only
  flexSlots: FlexSlot[],
  mealPrepPreferences: {
    recipes: RecipeRequest[],     // solver sees in-horizon eating occasions only (Plan 010)
  },
  breakfast: { locked, recipeSlug?, caloriesPerDay, proteinPerDay },
  horizonDays?: string[],         // explicit 7 ISO dates (D32 — closes latent getWeekDays bug)
  carriedOverSlots?: PreCommittedSlot[], // frozen macros from prior sessions' batches
}
```

## Outputs (`SolverOutput`)

```typescript
{
  isValid: boolean,
  weeklyTotals: {
    calories,                  // total including treat budget
    protein,
    treatBudget,               // protected allocation (5% of weekly)
    flexSlotCalories,          // sum of all flex bonuses
  },
  dailyBreakdown: DailyBreakdown[],     // per-day calories with sources
  batchTargets: BatchTarget[],           // uniform per-slot targets
  cookingSchedule: CookingScheduleDay[], // when to cook what
  warnings: string[],
}
```

## Constraints (enforced)

| Constraint | Value | Type |
|---|---|---|
| Min meal calories | 400 cal | Hard (clamped) |
| Max meal calories | 1000 cal (+ flex bonus for flex slots) | Hard (clamped) |
| Weekly calorie tolerance | ±3% | Hard (isValid = false) |
| Weekly protein minimum | 97% of target | Hard (isValid = false) |
| Low per-slot warning | < 650 cal | Soft (warning — suggests reducing events or treat budget) |
| Flex slots per week | Exactly `config.planning.flexSlotsPerWeek` (currently 1) | Hard constraint enforced by plan-proposer with retry |

## Cooking schedule

Strategy: cook each batch on the first eating day itself. The user cooks fresh on the day a batch starts being eaten, not the night before, to protect freshness across the 2–3 day window. Groups batches that cook on the same day.

## QA gate (`src/qa/validators/plan.ts`)

Validates solver output before the plan is shown to the user. Checks all hard constraints above, plus:
- Cook day must not be after the first eating day (cook day === first eating day is valid)
- Every day must have lunch + dinner covered (batch, event, or flex slot)
- Flex slots can exceed `MAX_MEAL_CAL` by their flex bonus amount
- Flex + treat allocation percentage is reasonable (warns if > hard cap, usually indicates unresolved recipe gaps)

When validation fails, the plan flow logs warnings but still presents the plan (the solver output is deterministic and self-consistent — validation catches edge cases).
