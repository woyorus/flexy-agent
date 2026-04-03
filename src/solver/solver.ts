/**
 * Budget solver — deterministic weekly calorie/protein allocation.
 *
 * This is the mathematical core of Flexie. It takes the week's shape (events,
 * fun foods, breakfast, meal prep requests) and produces a precise budget
 * allocation that the recipe engine fills.
 *
 * NO LLM is involved here. This is pure arithmetic.
 *
 * Algorithm (from spec Section 6):
 * 1. Allocate breakfast (fixed, subtracted upfront)
 * 2. Allocate fixed slots (restaurant meals + fun foods)
 * 3. Calculate remaining budget for meal preps
 * 4. Lay out the week grid (7 days × 3 meals)
 * 5. Distribute evenly across meal prep slots
 * 6. Group into batches
 * 7. Balance (enforce min/max per slot)
 * 8. Verify (weekly totals within tolerance)
 *
 * Budget pressure priority: when budget is tight, fun food absorbs first.
 * The 80% healthy structure is the last thing to shrink.
 *
 * Constraints:
 * - All servings in a batch have equal calorie targets (no waste)
 * - No meal slot below 400 cal or above 1000 cal
 * - Weekly calories within ±3% of target
 * - Protein minimum must be met
 * - Fun food should not exceed ~25% (soft, warn but allow)
 */

import { v4 as uuid } from 'uuid';
import type { FunFoodItem, MealEvent, Macros } from '../models/types.js';
import type {
  SolverInput,
  SolverOutput,
  DailyBreakdown,
  BatchTarget,
  CookingScheduleDay,
  RecipeRequest,
} from './types.js';

const MIN_MEAL_CAL = 400;
const MAX_MEAL_CAL = 1000;
const WEEKLY_TOLERANCE = 0.03; // ±3%
const FUN_FOOD_WARN_THRESHOLD = 0.25; // warn if >25%

/**
 * Solve the weekly budget allocation.
 *
 * @param input - The week's planning inputs (targets, events, fun foods, recipes, breakfast)
 * @returns Complete budget allocation with daily breakdowns and batch targets
 */
export function solve(input: SolverInput): SolverOutput {
  const warnings: string[] = [];

  // Step 1: Allocate breakfast
  const weeklyBreakfastCal = input.breakfast.caloriesPerDay * 7;
  const weeklyBreakfastProtein = input.breakfast.proteinPerDay * 7;

  // Step 2: Allocate fixed slots
  const totalEventsCal = input.events.reduce((sum, e) => sum + e.estimatedCalories, 0);
  const totalFunFoodCal = input.funFoods.reduce((sum, f) => sum + f.estimatedCalories, 0);

  // Budget pressure: if total fixed exceeds budget, trim fun food first
  const fixedTotal = weeklyBreakfastCal + totalEventsCal + totalFunFoodCal;
  let adjustedFunFoodCal = totalFunFoodCal;

  if (fixedTotal > input.weeklyTargets.calories) {
    const overage = fixedTotal - input.weeklyTargets.calories;
    const funFoodReduction = Math.min(overage, totalFunFoodCal);
    adjustedFunFoodCal = totalFunFoodCal - funFoodReduction;
    if (funFoodReduction > 0) {
      warnings.push(
        `Budget pressure: fun food reduced by ${Math.round(funFoodReduction)} cal to fit events.`
      );
    }
  }

  // Step 3: Calculate remaining budget for meal preps
  const remainingCal = input.weeklyTargets.calories - weeklyBreakfastCal - totalEventsCal - adjustedFunFoodCal;
  const remainingProtein = input.weeklyTargets.protein - weeklyBreakfastProtein -
    estimateEventProtein(input.events);

  // Step 4: Lay out the week grid
  const weekDays = getWeekDays(input.mealPrepPreferences.recipes);
  const eventsByDay = groupByDay(input.events, (e) => e.day);
  const funFoodsByDay = groupByDay(input.funFoods, (f) => f.day);

  // Count meal prep slots from actual recipe request servings.
  // This is the real number of meal prep portions, not theoretical open days.
  const mealPrepSlotCount = input.mealPrepPreferences.recipes.reduce(
    (sum, req) => sum + req.servings, 0
  );

  // Step 5: Distribute evenly across meal prep slots
  const calPerMealPrepSlot = mealPrepSlotCount > 0 ? remainingCal / mealPrepSlotCount : 0;
  const proteinPerMealPrepSlot = mealPrepSlotCount > 0 ? remainingProtein / mealPrepSlotCount : 0;

  // Step 6: Create batch targets from recipe requests
  const batchTargets: BatchTarget[] = input.mealPrepPreferences.recipes.map((req) => ({
    id: uuid(),
    recipeSlug: req.recipeSlug,
    mealType: req.mealType,
    days: req.days,
    servings: req.servings,
    targetPerServing: {
      calories: Math.round(calPerMealPrepSlot),
      protein: Math.round(proteinPerMealPrepSlot),
    },
  }));

  // Step 7: Balance — enforce min/max per slot
  for (const batch of batchTargets) {
    if (batch.targetPerServing.calories < MIN_MEAL_CAL) {
      warnings.push(
        `Batch ${batch.recipeSlug ?? 'new recipe'} (${batch.mealType}) target ${batch.targetPerServing.calories} cal is below minimum ${MIN_MEAL_CAL}. Clamped.`
      );
      batch.targetPerServing.calories = MIN_MEAL_CAL;
    }
    if (batch.targetPerServing.calories > MAX_MEAL_CAL) {
      warnings.push(
        `Batch ${batch.recipeSlug ?? 'new recipe'} (${batch.mealType}) target ${batch.targetPerServing.calories} cal exceeds maximum ${MAX_MEAL_CAL}. Clamped.`
      );
      batch.targetPerServing.calories = MAX_MEAL_CAL;
    }
  }

  // Fun food percentage check
  const funFoodPercent = adjustedFunFoodCal / input.weeklyTargets.calories;
  if (funFoodPercent > FUN_FOOD_WARN_THRESHOLD) {
    warnings.push(
      `Fun food is ${Math.round(funFoodPercent * 100)}% this week — higher than usual.`
    );
  }

  // Build daily breakdowns
  const dailyBreakdown = buildDailyBreakdown(
    weekDays,
    input,
    batchTargets,
    eventsByDay,
    funFoodsByDay,
    adjustedFunFoodCal,
  );

  // Build cooking schedule
  const cookingSchedule = buildCookingSchedule(batchTargets);

  // Step 8: Verify weekly totals
  const totalPlannedCal = dailyBreakdown.reduce((sum, d) => sum + d.totalCalories, 0);
  const totalPlannedProtein = dailyBreakdown.reduce((sum, d) => sum + d.totalProtein, 0);

  const calDeviation = Math.abs(totalPlannedCal - input.weeklyTargets.calories) / input.weeklyTargets.calories;
  const isValid = calDeviation <= WEEKLY_TOLERANCE && totalPlannedProtein >= input.weeklyTargets.protein * 0.97;

  if (!isValid) {
    warnings.push(
      `Weekly totals off target: ${totalPlannedCal} cal (target ${input.weeklyTargets.calories}), ${totalPlannedProtein}g protein (target ${input.weeklyTargets.protein}g).`
    );
  }

  return {
    isValid,
    weeklyTotals: {
      calories: totalPlannedCal,
      protein: totalPlannedProtein,
      funFoodCalories: adjustedFunFoodCal,
      funFoodPercent: Math.round(funFoodPercent * 1000) / 10, // one decimal
    },
    dailyBreakdown,
    batchTargets,
    cookingSchedule,
    warnings,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Extract the set of days covered by recipe requests.
 * Returns them sorted chronologically.
 */
function getWeekDays(recipes: RecipeRequest[]): string[] {
  const daySet = new Set<string>();
  for (const req of recipes) {
    for (const day of req.days) {
      daySet.add(day);
    }
  }
  return Array.from(daySet).sort();
}

/** Group items by day using a key extractor. */
function groupByDay<T>(items: T[], getDay: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const day = getDay(item);
    const existing = map.get(day) ?? [];
    existing.push(item);
    map.set(day, existing);
  }
  return map;
}

/**
 * Estimate protein from restaurant events.
 * Uses a rough 25g protein per event as a conservative placeholder.
 * The actual estimation happens in the restaurant estimator sub-agent;
 * the solver uses this as a minimum floor.
 */
function estimateEventProtein(events: MealEvent[]): number {
  return events.length * 25;
}

/**
 * Build the daily breakdown for each day of the week.
 */
function buildDailyBreakdown(
  weekDays: string[],
  input: SolverInput,
  batchTargets: BatchTarget[],
  eventsByDay: Map<string, MealEvent[]>,
  funFoodsByDay: Map<string, FunFoodItem[]>,
  adjustedFunFoodCal: number,
): DailyBreakdown[] {
  // Scale fun foods proportionally if budget was reduced
  const originalFunFoodCal = input.funFoods.reduce((s, f) => s + f.estimatedCalories, 0);
  const funFoodScale = originalFunFoodCal > 0 ? adjustedFunFoodCal / originalFunFoodCal : 1;

  return weekDays.map((day) => {
    const dayEvents = eventsByDay.get(day) ?? [];
    const dayFunFoods = (funFoodsByDay.get(day) ?? []).map((f) => ({
      ...f,
      estimatedCalories: Math.round(f.estimatedCalories * funFoodScale),
    }));

    const hasLunchEvent = dayEvents.some((e) => e.mealTime === 'lunch');
    const hasDinnerEvent = dayEvents.some((e) => e.mealTime === 'dinner');

    // Find batch targets for this day
    const lunchBatch = !hasLunchEvent
      ? batchTargets.find((b) => b.mealType === 'lunch' && b.days.includes(day))
      : undefined;
    const dinnerBatch = !hasDinnerEvent
      ? batchTargets.find((b) => b.mealType === 'dinner' && b.days.includes(day))
      : undefined;

    const lunchCal = hasLunchEvent
      ? (dayEvents.find((e) => e.mealTime === 'lunch')?.estimatedCalories ?? 0)
      : (lunchBatch?.targetPerServing.calories ?? 0);
    const lunchProtein = hasLunchEvent
      ? 25 // rough estimate for event protein
      : (lunchBatch?.targetPerServing.protein ?? 0);

    const dinnerCal = hasDinnerEvent
      ? (dayEvents.find((e) => e.mealTime === 'dinner')?.estimatedCalories ?? 0)
      : (dinnerBatch?.targetPerServing.calories ?? 0);
    const dinnerProtein = hasDinnerEvent
      ? 25
      : (dinnerBatch?.targetPerServing.protein ?? 0);

    const funFoodCal = dayFunFoods.reduce((s, f) => s + f.estimatedCalories, 0);

    const totalCalories =
      input.breakfast.caloriesPerDay + lunchCal + dinnerCal + funFoodCal;
    const totalProtein =
      input.breakfast.proteinPerDay + lunchProtein + dinnerProtein;

    return {
      day,
      totalCalories,
      totalProtein,
      breakfast: {
        calories: input.breakfast.caloriesPerDay,
        protein: input.breakfast.proteinPerDay,
      },
      lunch: {
        calories: lunchCal,
        protein: lunchProtein,
        batchId: lunchBatch?.id,
      },
      dinner: {
        calories: dinnerCal,
        protein: dinnerProtein,
        batchId: dinnerBatch?.id,
      },
      funFoods: dayFunFoods,
      events: dayEvents,
    };
  });
}

/**
 * Build the cooking schedule from batch targets.
 *
 * Strategy: cook each batch on the first day it's needed (or the day before
 * if it starts on day 1). Groups batches that need to be cooked on the same day.
 */
function buildCookingSchedule(batchTargets: BatchTarget[]): CookingScheduleDay[] {
  const scheduleMap = new Map<string, string[]>();

  for (const batch of batchTargets) {
    if (batch.days.length === 0) continue;
    // Cook day = the day before the first eating day, or the first eating day itself
    const firstEatDay = batch.days[0]!;
    const cookDay = dayBefore(firstEatDay);

    const existing = scheduleMap.get(cookDay) ?? [];
    existing.push(batch.id);
    scheduleMap.set(cookDay, existing);
  }

  return Array.from(scheduleMap.entries())
    .map(([day, batchIds]) => ({ day, batchIds }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Get the ISO date string for the day before a given date. */
function dayBefore(isoDate: string): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0]!;
}
