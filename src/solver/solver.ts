/**
 * Budget solver — deterministic weekly calorie/protein allocation.
 *
 * This is the mathematical core of Flexie. It takes the week's shape (events,
 * fun foods, breakfast, meal prep requests) and produces a precise budget
 * allocation that the recipe engine fills.
 *
 * NO LLM is involved here. This is pure arithmetic.
 *
 * Algorithm (see docs/product-specs/solver.md):
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
import type { FlexSlot, MealEvent, Macros } from '../models/types.js';
import { config } from '../config.js';
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

/** Warn if the derived treat budget drops below this threshold. */
const MIN_TREAT_BUDGET_WARNING = 300;

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

  // Step 2: Allocate events
  const totalEventsCal = input.events.reduce((sum, e) => sum + e.estimatedCalories, 0);

  // Step 3: Flex slot bonuses
  const totalFlexBonus = input.flexSlots.reduce((sum, f) => sum + f.flexBonus, 0);

  // Step 4: Lay out the week grid
  const weekDays = getWeekDays(input.mealPrepPreferences.recipes, input.flexSlots);
  const eventsByDay = groupByDay(input.events, (e) => e.day);
  const flexSlotsByDay = groupByDay(input.flexSlots, (f) => f.day);

  // Step 5: Create batch targets using real recipe macros.
  // Each recipe keeps its natural per-serving calories — no forced scaling.
  // For recipes without known macros (newly generated), use the average of known ones.
  const recipesWithMacros = input.mealPrepPreferences.recipes.filter((r) => r.actualMacros);
  const avgRecipeCal = recipesWithMacros.length > 0
    ? Math.round(recipesWithMacros.reduce((s, r) => s + r.actualMacros!.calories, 0) / recipesWithMacros.length)
    : Math.round(config.targets.daily.calories * 0.365);
  const avgRecipeProtein = recipesWithMacros.length > 0
    ? Math.round(recipesWithMacros.reduce((s, r) => s + r.actualMacros!.protein, 0) / recipesWithMacros.length)
    : Math.round(config.targets.daily.protein * 0.365);

  const batchTargets: BatchTarget[] = input.mealPrepPreferences.recipes.map((req) => ({
    id: uuid(),
    recipeSlug: req.recipeSlug,
    mealType: req.mealType,
    days: req.days,
    servings: req.servings,
    targetPerServing: {
      calories: req.actualMacros?.calories ?? avgRecipeCal,
      protein: req.actualMacros?.protein ?? avgRecipeProtein,
    },
  }));

  // Step 6: Balance — enforce min/max per slot
  for (const batch of batchTargets) {
    if (batch.targetPerServing.calories < MIN_MEAL_CAL) {
      warnings.push(
        `Batch ${batch.recipeSlug ?? 'new recipe'} (${batch.mealType}) at ${batch.targetPerServing.calories} cal is below minimum ${MIN_MEAL_CAL}. Clamped.`
      );
      batch.targetPerServing.calories = MIN_MEAL_CAL;
    }
    if (batch.targetPerServing.calories > MAX_MEAL_CAL) {
      warnings.push(
        `Batch ${batch.recipeSlug ?? 'new recipe'} (${batch.mealType}) at ${batch.targetPerServing.calories} cal exceeds maximum ${MAX_MEAL_CAL}. Clamped.`
      );
      batch.targetPerServing.calories = MAX_MEAL_CAL;
    }
  }

  // Build daily breakdowns
  const dailyBreakdown = buildDailyBreakdown(
    weekDays,
    input,
    batchTargets,
    eventsByDay,
    flexSlotsByDay,
    avgRecipeCal,
    avgRecipeProtein,
  );

  // Build cooking schedule
  const cookingSchedule = buildCookingSchedule(batchTargets);

  // Step 7: Derive the treat budget from what's left.
  // The treat budget is NOT a fixed reserve — it's the honest remainder after
  // all planned meals are accounted for. This ensures meals keep their natural
  // per-serving calories (no shrinking to make room for a predetermined pool).
  const plannedCal = dailyBreakdown.reduce((sum, d) => sum + d.totalCalories, 0);
  const totalPlannedProtein = dailyBreakdown.reduce((sum, d) => sum + d.totalProtein, 0);
  const treatBudget = Math.max(0, input.weeklyTargets.calories - plannedCal);
  const funFoodPool = totalFlexBonus + treatBudget;
  const funFoodPercent = funFoodPool / input.weeklyTargets.calories;

  if (treatBudget < MIN_TREAT_BUDGET_WARNING) {
    warnings.push(
      `Treat headroom is tight: only ${treatBudget} cal/week (~${Math.round(treatBudget / 7)} cal/day) left for snacks. Consider lower-calorie recipes for more room.`
    );
  }

  // Step 8: Verify weekly totals
  const totalAllocatedCal = plannedCal + treatBudget; // by definition = weeklyTargets.calories
  const calDeviation = Math.abs(totalAllocatedCal - input.weeklyTargets.calories) / input.weeklyTargets.calories;
  const isValid = calDeviation <= WEEKLY_TOLERANCE && totalPlannedProtein >= input.weeklyTargets.protein * 0.97;

  if (!isValid && calDeviation > WEEKLY_TOLERANCE) {
    warnings.push(
      `Weekly calories ${totalAllocatedCal} deviate ${(calDeviation * 100).toFixed(1)}% from target ${input.weeklyTargets.calories}.`
    );
  }
  if (totalPlannedProtein < input.weeklyTargets.protein * 0.97) {
    warnings.push(
      `Weekly protein ${totalPlannedProtein}g is below target ${input.weeklyTargets.protein}g.`
    );
  }

  return {
    isValid,
    weeklyTotals: {
      calories: totalAllocatedCal,
      protein: totalPlannedProtein,
      funFoodPool,
      flexSlotCalories: totalFlexBonus,
      treatBudget,
      funFoodPercent: Math.round(funFoodPercent * 1000) / 10,
    },
    dailyBreakdown,
    batchTargets,
    cookingSchedule,
    warnings,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Extract the set of days covered by recipe requests and flex slots.
 * Returns them sorted chronologically.
 */
function getWeekDays(recipes: RecipeRequest[], flexSlots: FlexSlot[]): string[] {
  const daySet = new Set<string>();
  for (const req of recipes) {
    for (const day of req.days) {
      daySet.add(day);
    }
  }
  for (const flex of flexSlots) {
    daySet.add(flex.day);
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
 *
 * Batch slots use the recipe's actual per-serving macros (from the batch target).
 * Flex slots use the fallback average + their flex bonus.
 */
function buildDailyBreakdown(
  weekDays: string[],
  input: SolverInput,
  batchTargets: BatchTarget[],
  eventsByDay: Map<string, MealEvent[]>,
  flexSlotsByDay: Map<string, FlexSlot[]>,
  flexBaseCal: number,
  flexBaseProtein: number,
): DailyBreakdown[] {
  return weekDays.map((day) => {
    const dayEvents = eventsByDay.get(day) ?? [];
    const dayFlexSlots = flexSlotsByDay.get(day) ?? [];

    const hasLunchEvent = dayEvents.some((e) => e.mealTime === 'lunch');
    const hasDinnerEvent = dayEvents.some((e) => e.mealTime === 'dinner');
    const lunchFlex = dayFlexSlots.find((f) => f.mealTime === 'lunch');
    const dinnerFlex = dayFlexSlots.find((f) => f.mealTime === 'dinner');

    // Find batch targets for this day (only if not an event or flex slot)
    const lunchBatch = (!hasLunchEvent && !lunchFlex)
      ? batchTargets.find((b) => b.mealType === 'lunch' && b.days.includes(day))
      : undefined;
    const dinnerBatch = (!hasDinnerEvent && !dinnerFlex)
      ? batchTargets.find((b) => b.mealType === 'dinner' && b.days.includes(day))
      : undefined;

    // Lunch calories: event > flex > batch
    let lunchCal: number;
    let lunchProtein: number;
    let lunchFlexBonus: number | undefined;
    if (hasLunchEvent) {
      lunchCal = dayEvents.find((e) => e.mealTime === 'lunch')?.estimatedCalories ?? 0;
      lunchProtein = 25;
    } else if (lunchFlex) {
      lunchCal = flexBaseCal + lunchFlex.flexBonus;
      lunchProtein = flexBaseProtein;
      lunchFlexBonus = lunchFlex.flexBonus;
    } else {
      lunchCal = lunchBatch?.targetPerServing.calories ?? 0;
      lunchProtein = lunchBatch?.targetPerServing.protein ?? 0;
    }

    // Dinner calories: event > flex > batch
    let dinnerCal: number;
    let dinnerProtein: number;
    let dinnerFlexBonus: number | undefined;
    if (hasDinnerEvent) {
      dinnerCal = dayEvents.find((e) => e.mealTime === 'dinner')?.estimatedCalories ?? 0;
      dinnerProtein = 25;
    } else if (dinnerFlex) {
      dinnerCal = flexBaseCal + dinnerFlex.flexBonus;
      dinnerProtein = flexBaseProtein;
      dinnerFlexBonus = dinnerFlex.flexBonus;
    } else {
      dinnerCal = dinnerBatch?.targetPerServing.calories ?? 0;
      dinnerProtein = dinnerBatch?.targetPerServing.protein ?? 0;
    }

    const totalCalories = input.breakfast.caloriesPerDay + lunchCal + dinnerCal;
    const totalProtein = input.breakfast.proteinPerDay + lunchProtein + dinnerProtein;

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
        flexBonus: lunchFlexBonus,
      },
      dinner: {
        calories: dinnerCal,
        protein: dinnerProtein,
        batchId: dinnerBatch?.id,
        flexBonus: dinnerFlexBonus,
      },
      flexSlots: dayFlexSlots,
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
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return toLocalISODate(d);
}

/** Format a Date as YYYY-MM-DD using local time (not UTC). */
function toLocalISODate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
