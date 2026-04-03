/**
 * Recipe validator.
 *
 * Validates a recipe against the constraints in spec Section 6.2:
 * - Calories per serving within ±5% of target
 * - Protein per serving within ±5% of target
 * - Fat and carbs present and reasonable
 * - Ingredient amounts reasonable (no 500g of salt, no 5g of chicken)
 * - All required fields present
 * - Ingredient roles assigned
 * - Total ingredient calories approximately match stated macros (internal consistency)
 */

import type { Recipe, Macros } from '../../models/types.js';

export interface RecipeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const MACRO_TOLERANCE = 0.05; // ±5%

/** Rough calories per gram for consistency check */
const CAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

/**
 * Validate a recipe against its target macros and internal consistency rules.
 *
 * @param recipe - The recipe to validate
 * @param target - The solver's target macros for this recipe (optional — skip macro comparison if not provided)
 * @returns Validation result
 */
export function validateRecipe(recipe: Recipe, target?: Macros): RecipeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!recipe.name) errors.push('Missing recipe name.');
  if (!recipe.slug) errors.push('Missing recipe slug.');
  if (!recipe.ingredients?.length) errors.push('No ingredients.');
  if (!recipe.steps) errors.push('No steps.');
  if (!recipe.perServing) errors.push('Missing per-serving macros.');

  if (recipe.perServing) {
    // Fat and carbs must be present
    if (recipe.perServing.fat <= 0) errors.push('Fat must be positive.');
    if (recipe.perServing.carbs <= 0) errors.push('Carbs must be positive.');

    // Internal consistency: do stated macros add up to stated calories?
    const calculatedCal =
      recipe.perServing.protein * CAL_PER_GRAM.protein +
      recipe.perServing.carbs * CAL_PER_GRAM.carbs +
      recipe.perServing.fat * CAL_PER_GRAM.fat;
    const calDev = Math.abs(calculatedCal - recipe.perServing.calories) / recipe.perServing.calories;
    if (calDev > 0.10) {
      warnings.push(
        `Stated calories (${recipe.perServing.calories}) vs calculated from macros (${Math.round(calculatedCal)}) differ by ${(calDev * 100).toFixed(1)}%.`
      );
    }
    if (calDev > 0.20) {
      errors.push(
        `Stated calories (${recipe.perServing.calories}) vs calculated from macros (${Math.round(calculatedCal)}) differ by ${(calDev * 100).toFixed(1)}% — too large.`
      );
    }
  }

  // Target macro comparison
  if (target && recipe.perServing) {
    const calDev = Math.abs(recipe.perServing.calories - target.calories) / target.calories;
    if (calDev > MACRO_TOLERANCE) {
      errors.push(
        `Calories ${recipe.perServing.calories} deviates ${(calDev * 100).toFixed(1)}% from target ${target.calories} (max ±${MACRO_TOLERANCE * 100}%).`
      );
    }
    const protDev = Math.abs(recipe.perServing.protein - target.protein) / target.protein;
    if (protDev > MACRO_TOLERANCE) {
      errors.push(
        `Protein ${recipe.perServing.protein}g deviates ${(protDev * 100).toFixed(1)}% from target ${target.protein}g (max ±${MACRO_TOLERANCE * 100}%).`
      );
    }
  }

  // Ingredient roles
  for (const ing of recipe.ingredients ?? []) {
    if (!ing.role) {
      errors.push(`Ingredient "${ing.name}" has no role assigned.`);
    }
  }

  // Ingredient amount sanity checks
  for (const ing of recipe.ingredients ?? []) {
    if (ing.role === 'seasoning' && ing.unit === 'g' && ing.amount > 50) {
      warnings.push(`Seasoning "${ing.name}" at ${ing.amount}g seems high.`);
    }
    if (ing.role === 'protein' && ing.unit === 'g' && ing.amount < 20) {
      warnings.push(`Protein ingredient "${ing.name}" at ${ing.amount}g seems low.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
