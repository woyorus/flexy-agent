/**
 * Budget solver — deterministic weekly calorie/protein allocation.
 *
 * This is the mathematical core of Flexie. It takes the week's shape (events,
 * flex slots, breakfast, meal prep requests) and produces a precise budget
 * allocation that the recipe scaler fills.
 *
 * NO LLM is involved here. This is pure arithmetic.
 *
 * Algorithm (see docs/plans/001-calorie-budget-redesign.md):
 * 1. Allocate breakfast (fixed, subtracted upfront)
 * 2. Allocate meal-replacement events (restaurants — not treat events)
 * 3. Sum flex slot bonuses
 * 4. Protect treat budget (config.targets.treatBudgetPercent of weekly)
 * 5. Compute meal prep budget (remainder after 1-4)
 * 6. Distribute evenly: mealPrepBudget / totalSlots → uniform per-slot target
 * 7. Balance (enforce min/max per slot)
 * 8. Verify (weekly totals within tolerance)
 *
 * Budget pressure priority: when events squeeze the budget, meal prep
 * slots get smaller. The treat budget is protected and never shrinks.
 *
 * Constraints:
 * - All servings in a batch have equal calorie targets (uniform distribution)
 * - No meal slot below 400 cal or above 1000 cal
 * - Weekly calories within ±3% of target
 * - Protein minimum must be met
 * - Solver warns if per-slot drops below 650 cal
 */

import { v4 as uuid } from 'uuid';
import type { FlexSlot, MealEvent } from '../models/types.js';
import { config } from '../config.js';
import type {
  SolverInput,
  SolverOutput,
  DailyBreakdown,
  BatchTarget,
  CookingScheduleDay,
  RecipeRequest,
  PreCommittedSlot,
} from './types.js';

const MIN_MEAL_CAL = 400;
const MAX_MEAL_CAL = 1000;
const WEEKLY_TOLERANCE = 0.03; // ±3%
const LOW_MEAL_WARNING = 650;

/**
 * Solve the weekly budget allocation.
 *
 * @param input - The week's planning inputs (targets, events, fun foods, recipes, breakfast)
 * @returns Complete budget allocation with daily breakdowns and batch targets
 */
export function solve(input: SolverInput): SolverOutput {
  const warnings: string[] = [];
  const carried = input.carriedOverSlots ?? [];

  // Step 1: Allocate breakfast
  const weeklyBreakfastCal = input.breakfast.caloriesPerDay * 7;
  const weeklyBreakfastProtein = input.breakfast.proteinPerDay * 7;

  // Step 2: Allocate meal-replacement events (restaurants, not treat events)
  const totalEventsCal = input.events.reduce((sum, e) => sum + e.estimatedCalories, 0);
  const eventProtein = input.events.length * 25; // conservative per-event estimate

  // Step 3: Flex slot bonuses
  const totalFlexBonus = input.flexSlots.reduce((sum, f) => sum + f.flexBonus, 0);

  // Step 4: Protected treat budget — reserved upfront, never squeezed by events
  const treatBudget = Math.round(input.weeklyTargets.calories * config.targets.treatBudgetPercent);

  // Plan 007: subtract pre-committed slot calories/protein from budget
  const preCommittedCal = carried.reduce((s, x) => s + x.calories, 0);
  const preCommittedProtein = carried.reduce((s, x) => s + x.protein, 0);

  // Step 5: Meal prep budget — what's left for all non-breakfast, non-event slots
  const mealPrepBudget = input.weeklyTargets.calories - weeklyBreakfastCal - totalEventsCal - totalFlexBonus - treatBudget - preCommittedCal;

  // Step 6: Count all slots (recipe servings + flex slots — pre-committed are already covered)
  const recipeServings = input.mealPrepPreferences.recipes.reduce((sum, r) => sum + r.servings, 0);
  const totalSlots = recipeServings + input.flexSlots.length;

  // Step 7: Uniform per-slot target
  const perSlotCal = totalSlots > 0 ? Math.round(mealPrepBudget / totalSlots) : 0;
  const mealProteinBudget = input.weeklyTargets.protein - weeklyBreakfastProtein - eventProtein - preCommittedProtein;
  const perSlotProtein = totalSlots > 0 ? Math.round(mealProteinBudget / totalSlots) : 0;

  if (perSlotCal < LOW_MEAL_WARNING && totalSlots > 0) {
    warnings.push(
      `Per-meal target ${perSlotCal} cal is very low. Consider fewer events or a lower treat budget.`
    );
  }

  // Step 8: Lay out the week grid — use explicit horizonDays if provided (D32)
  const weekDays = resolveHorizonDays(input);
  const eventsByDay = groupByDay(input.events, (e) => e.day);
  const flexSlotsByDay = groupByDay(input.flexSlots, (f) => f.day);
  const carriedByDayMeal = groupCarriedSlots(carried);

  // Step 9: Create batch targets (uniform per-slot calories)
  const batchTargets: BatchTarget[] = input.mealPrepPreferences.recipes.map((req) => ({
    id: uuid(),
    recipeSlug: req.recipeSlug,
    mealType: req.mealType,
    days: req.days,
    servings: req.servings,
    targetPerServing: {
      calories: perSlotCal,
      protein: perSlotProtein,
    },
  }));

  // Step 10: Balance — enforce min/max per slot
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
    carriedByDayMeal,
    perSlotCal,
    perSlotProtein,
  );

  // Build cooking schedule
  const cookingSchedule = buildCookingSchedule(batchTargets);

  // Verify weekly totals
  const plannedCal = dailyBreakdown.reduce((sum, d) => sum + d.totalCalories, 0);
  const totalPlannedProtein = dailyBreakdown.reduce((sum, d) => sum + d.totalProtein, 0);
  const totalAllocatedCal = plannedCal + treatBudget;
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
      treatBudget,
      flexSlotCalories: totalFlexBonus,
    },
    dailyBreakdown,
    batchTargets,
    cookingSchedule,
    warnings,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Resolve the horizon days for the solver.
 *
 * Plan 007 (D32): if `horizonDays` is provided, use it directly (7 explicit
 * ISO dates). This closes a latent bug where days covered only by events were
 * missing from dailyBreakdown. Falls back to the legacy derivation from
 * recipes + flexSlots during the strangler-fig window.
 */
function resolveHorizonDays(input: SolverInput): string[] {
  if (input.horizonDays) {
    return input.horizonDays;
  }
  // Legacy fallback: derive from recipes + flexSlots
  const daySet = new Set<string>();
  for (const req of input.mealPrepPreferences.recipes) {
    for (const day of req.days) {
      daySet.add(day);
    }
  }
  for (const flex of input.flexSlots) {
    daySet.add(flex.day);
  }
  return Array.from(daySet).sort();
}

/**
 * Group pre-committed slots by "day:mealTime" for O(1) lookup in buildDailyBreakdown.
 */
function groupCarriedSlots(slots: PreCommittedSlot[]): Map<string, PreCommittedSlot> {
  const map = new Map<string, PreCommittedSlot>();
  for (const s of slots) {
    map.set(`${s.day}:${s.mealTime}`, s);
  }
  return map;
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
 * Build the daily breakdown for each day of the week.
 *
 * All meal-prep slots use the uniform per-slot target from the solver.
 * Flex slots use the same base + their flex bonus.
 * Pre-committed slots (Plan 007) use frozen macros from the source batch.
 *
 * Source priority per (day, mealTime): event > flex > pre-committed > new batch.
 */
function buildDailyBreakdown(
  weekDays: string[],
  input: SolverInput,
  batchTargets: BatchTarget[],
  eventsByDay: Map<string, MealEvent[]>,
  flexSlotsByDay: Map<string, FlexSlot[]>,
  carriedByDayMeal: Map<string, PreCommittedSlot>,
  flexBaseCal: number,
  flexBaseProtein: number,
): DailyBreakdown[] {
  return weekDays.map((day) => {
    const dayEvents = eventsByDay.get(day) ?? [];
    const dayFlexSlots = flexSlotsByDay.get(day) ?? [];
    const lunchCarried = carriedByDayMeal.get(`${day}:lunch`);
    const dinnerCarried = carriedByDayMeal.get(`${day}:dinner`);

    const hasLunchEvent = dayEvents.some((e) => e.mealTime === 'lunch');
    const hasDinnerEvent = dayEvents.some((e) => e.mealTime === 'dinner');
    const lunchFlex = dayFlexSlots.find((f) => f.mealTime === 'lunch');
    const dinnerFlex = dayFlexSlots.find((f) => f.mealTime === 'dinner');

    // Find batch targets for this day (only if not covered by event, flex, or pre-committed)
    const lunchBatch = (!hasLunchEvent && !lunchFlex && !lunchCarried)
      ? batchTargets.find((b) => b.mealType === 'lunch' && b.days.includes(day))
      : undefined;
    const dinnerBatch = (!hasDinnerEvent && !dinnerFlex && !dinnerCarried)
      ? batchTargets.find((b) => b.mealType === 'dinner' && b.days.includes(day))
      : undefined;

    // Lunch calories: event > flex > pre-committed > batch
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
    } else if (lunchCarried) {
      lunchCal = lunchCarried.calories;
      lunchProtein = lunchCarried.protein;
    } else {
      lunchCal = lunchBatch?.targetPerServing.calories ?? 0;
      lunchProtein = lunchBatch?.targetPerServing.protein ?? 0;
    }

    // Dinner calories: event > flex > pre-committed > batch
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
    } else if (dinnerCarried) {
      dinnerCal = dinnerCarried.calories;
      dinnerProtein = dinnerCarried.protein;
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
 * Strategy: cook each batch on the first eating day itself. The user cooks
 * fresh on the day a batch starts being eaten, not the night before — this
 * protects freshness across the 2–3 day batch window. Groups batches that
 * cook on the same day.
 */
function buildCookingSchedule(batchTargets: BatchTarget[]): CookingScheduleDay[] {
  const scheduleMap = new Map<string, string[]>();

  for (const batch of batchTargets) {
    if (batch.days.length === 0) continue;
    // Cook day = first eating day. The user cooks fresh on the day a batch
    // starts being eaten, not the night before — protecting freshness across
    // the 2-3 day batch window. See docs/plans/active/008-cook-day-hotfix.md.
    const cookDay = batch.days[0]!;

    const existing = scheduleMap.get(cookDay) ?? [];
    existing.push(batch.id);
    scheduleMap.set(cookDay, existing);
  }

  return Array.from(scheduleMap.entries())
    .map(([day, batchIds]) => ({ day, batchIds }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
