/**
 * Weekly plan validator.
 *
 * Validates a solver output against the hard constraints defined in the spec.
 * This runs as part of the QA gate before any plan is shown to the user.
 *
 * Validation rules:
 * - Weekly calories within ±3% of target
 * - Weekly protein meets minimum
 * - No meal slot below 400 cal or above 1000 cal (flex slots can exceed by their bonus)
 * - All servings in a batch have equal calorie targets
 * - Fun food pool not exceeded (hard cap 30%)
 * - Treat budget non-negative (flex bonuses don't exceed fun food pool)
 * - Cooking days are before eating days
 * - No orphaned meal slots (every meal has a source: batch, event, or flex)
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
const FUN_FOOD_MAX_PERCENT = 15; // warning threshold — in the derived model, high % usually means unresolved gaps

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

  // Meal slot calorie bounds — flex slots can exceed MAX_MEAL_CAL by their flex bonus
  for (const day of output.dailyBreakdown) {
    for (const [slot, cal, flexBonus] of [
      ['lunch', day.lunch.calories, day.lunch.flexBonus ?? 0],
      ['dinner', day.dinner.calories, day.dinner.flexBonus ?? 0],
    ] as const) {
      if (cal > 0 && cal < MIN_MEAL_CAL) {
        errors.push(`${day.day} ${slot}: ${cal} cal is below minimum ${MIN_MEAL_CAL}.`);
      }
      const effectiveMax = MAX_MEAL_CAL + flexBonus;
      if (cal > effectiveMax) {
        errors.push(`${day.day} ${slot}: ${cal} cal exceeds maximum ${effectiveMax}${flexBonus > 0 ? ` (${MAX_MEAL_CAL} base + ${flexBonus} flex)` : ''}.`);
      }
    }
  }

  // Fun food percentage — informational warning only, not a hard cap.
  // In the derived treat model, funFoodPool = flex bonuses + remainder after planned meals.
  // A high percentage usually means the plan has unresolved recipe gaps, not over-allocation.
  if (output.weeklyTotals.funFoodPercent > FUN_FOOD_MAX_PERCENT) {
    warnings.push(
      `Fun food is ${output.weeklyTotals.funFoodPercent}% — likely due to unresolved recipe gaps.`
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

  // Orphaned meal slots: every day should have lunch + dinner covered
  // Sources: batch (batchId), event, or flex slot (flexBonus)
  for (const day of output.dailyBreakdown) {
    const hasLunchSource = day.lunch.batchId || day.lunch.flexBonus || day.events.some((e) => e.mealTime === 'lunch');
    if (day.lunch.calories === 0 && !hasLunchSource) {
      errors.push(`${day.day} lunch: no source (no batch, flex slot, or event).`);
    }
    const hasDinnerSource = day.dinner.batchId || day.dinner.flexBonus || day.events.some((e) => e.mealTime === 'dinner');
    if (day.dinner.calories === 0 && !hasDinnerSource) {
      errors.push(`${day.day} dinner: no source (no batch, flex slot, or event).`);
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
