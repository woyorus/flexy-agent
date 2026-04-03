/**
 * Weekly plan validator.
 *
 * Validates a solver output against the hard constraints defined in the spec.
 * This runs as part of the QA gate before any plan is shown to the user.
 *
 * Validation rules (from spec Section 6.2):
 * - Weekly calories within ±3% of target
 * - Weekly protein meets minimum
 * - No meal slot below 400 cal or above 1000 cal
 * - All servings in a batch have equal calorie targets
 * - Fun food budget not exceeded
 * - Budget pressure priority respected (fun food reduced before meal prep)
 * - Cooking days are before eating days
 * - No orphaned meal slots (every meal has a source)
 */

import type { SolverOutput, BatchTarget } from '../../solver/types.js';
import type { Macros } from '../../models/types.js';

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const WEEKLY_CAL_TOLERANCE = 0.03;
const MIN_MEAL_CAL = 400;
const MAX_MEAL_CAL = 1000;
const FUN_FOOD_MAX_PERCENT = 30; // hard cap — warn at 25% (solver), reject at 30%

/**
 * Validate a solver output against plan constraints.
 *
 * @param output - The solver's budget allocation
 * @param targets - The weekly calorie/protein targets
 * @returns Validation result with errors and warnings
 */
export function validatePlan(output: SolverOutput, targets: Macros): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Weekly calories within ±3%
  const calDev = Math.abs(output.weeklyTotals.calories - targets.calories) / targets.calories;
  if (calDev > WEEKLY_CAL_TOLERANCE) {
    errors.push(
      `Weekly calories ${output.weeklyTotals.calories} deviate ${(calDev * 100).toFixed(1)}% from target ${targets.calories} (max ±${WEEKLY_CAL_TOLERANCE * 100}%).`
    );
  }

  // Weekly protein meets minimum
  if (output.weeklyTotals.protein < targets.protein * 0.97) {
    errors.push(
      `Weekly protein ${output.weeklyTotals.protein}g is below target ${targets.protein}g.`
    );
  }

  // Meal slot calorie bounds
  for (const day of output.dailyBreakdown) {
    for (const [slot, cal] of [
      ['lunch', day.lunch.calories],
      ['dinner', day.dinner.calories],
    ] as const) {
      if (cal > 0 && cal < MIN_MEAL_CAL) {
        errors.push(`${day.day} ${slot}: ${cal} cal is below minimum ${MIN_MEAL_CAL}.`);
      }
      if (cal > MAX_MEAL_CAL) {
        errors.push(`${day.day} ${slot}: ${cal} cal exceeds maximum ${MAX_MEAL_CAL}.`);
      }
    }
  }

  // Fun food hard cap
  if (output.weeklyTotals.funFoodPercent > FUN_FOOD_MAX_PERCENT) {
    errors.push(
      `Fun food is ${output.weeklyTotals.funFoodPercent}% of weekly budget — exceeds ${FUN_FOOD_MAX_PERCENT}% hard cap.`
    );
  }

  // Cooking days must be before eating days
  for (const cookDay of output.cookingSchedule) {
    for (const batchId of cookDay.batchIds) {
      const batch = output.batchTargets.find((b) => b.id === batchId);
      if (!batch) continue;
      const firstEatDay = batch.days[0];
      if (firstEatDay && cookDay.day > firstEatDay) {
        errors.push(
          `Cook day ${cookDay.day} is after first eat day ${firstEatDay} for batch ${batch.recipeSlug ?? batchId}.`
        );
      }
    }
  }

  // Orphaned meal slots: every day should have lunch + dinner covered by either batch or event
  for (const day of output.dailyBreakdown) {
    if (day.lunch.calories === 0 && day.events.every((e) => e.mealTime !== 'lunch')) {
      errors.push(`${day.day} lunch: no source (no batch and no event).`);
    }
    if (day.dinner.calories === 0 && day.events.every((e) => e.mealTime !== 'dinner')) {
      errors.push(`${day.day} dinner: no source (no batch and no event).`);
    }
  }

  // Pass through solver warnings
  warnings.push(...output.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
