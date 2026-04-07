/**
 * Recipe validator.
 *
 * Validates a recipe against the constraints in docs/product-specs/recipes.md:
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

const CAL_TOLERANCE = 0.03;  // ±3% — tight, calories are the core product constraint
const PROT_TOLERANCE = 0.05; // ±5%

/** Atwater factors — calories per gram of each macronutrient. */
export const CAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 } as const;

/**
 * Check that stated calories match the Atwater formula from macros:
 *   calories = 4 × protein + 4 × carbs + 9 × fat  (all grams)
 *
 * LLMs frequently pick macros that don't add up to the stated calorie count.
 * This is a hard internal consistency requirement — it has nothing to do with
 * hitting a target, it's about the recipe being mathematically coherent.
 *
 * Returns the computed calories, absolute deviation, and percent deviation.
 */
export function computeMacroCalorieConsistency(macros: {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}): { computed: number; deviation: number; deviationPct: number } {
  const computed =
    macros.protein * CAL_PER_GRAM.protein +
    macros.carbs * CAL_PER_GRAM.carbs +
    macros.fat * CAL_PER_GRAM.fat;
  const deviation = Math.abs(computed - macros.calories);
  const deviationPct = macros.calories > 0 ? deviation / macros.calories : 0;
  return {
    computed: Math.round(computed),
    deviation: Math.round(deviation),
    deviationPct,
  };
}

/** Max acceptable deviation between stated calories and Atwater-computed calories. */
export const MACRO_CAL_TOLERANCE = 0.05; // ±5%

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
  if (!recipe.body) errors.push('No recipe body text.');
  if (!recipe.perServing) errors.push('Missing per-serving macros.');

  if (recipe.perServing) {
    // Fat and carbs must be present
    if (recipe.perServing.fat <= 0) errors.push('Fat must be positive.');
    if (recipe.perServing.carbs <= 0) errors.push('Carbs must be positive.');

    // Internal consistency: stated macros must add up to stated calories
    // via Atwater factors (4P + 4C + 9F). This is a hard requirement —
    // a recipe that doesn't math-check is incoherent regardless of targets.
    const { computed, deviationPct } = computeMacroCalorieConsistency(recipe.perServing);
    if (deviationPct > MACRO_CAL_TOLERANCE) {
      errors.push(
        `Macro/calorie mismatch: stated ${recipe.perServing.calories} cal vs computed ${computed} cal from macros (${recipe.perServing.protein}P + ${recipe.perServing.carbs}C + ${recipe.perServing.fat}F), off by ${(deviationPct * 100).toFixed(1)}%.`
      );
    }
  }

  // Target macro comparison
  if (target && recipe.perServing) {
    const calDev = Math.abs(recipe.perServing.calories - target.calories) / target.calories;
    if (calDev > CAL_TOLERANCE) {
      errors.push(
        `Calories ${recipe.perServing.calories} deviates ${(calDev * 100).toFixed(1)}% from target ${target.calories} (max ±${CAL_TOLERANCE * 100}%).`
      );
    }
    const protDev = Math.abs(recipe.perServing.protein - target.protein) / target.protein;
    if (protDev > PROT_TOLERANCE) {
      errors.push(
        `Protein ${recipe.perServing.protein}g deviates ${(protDev * 100).toFixed(1)}% from target ${target.protein}g (max ±${PROT_TOLERANCE * 100}%).`
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

  // Prep time sanity check — LLMs consistently underestimate cook times
  if (recipe.prepTimeMinutes) {
    const ingredientCount = recipe.ingredients?.length ?? 0;
    const isBreakfast = recipe.mealTypes?.includes('breakfast');
    if (isBreakfast && recipe.prepTimeMinutes < 10) {
      warnings.push(`Prep time ${recipe.prepTimeMinutes} min seems too low for breakfast (min ~10 min).`);
    }
    if (!isBreakfast && recipe.prepTimeMinutes < 25) {
      errors.push(`Prep time ${recipe.prepTimeMinutes} min is unrealistically low for a lunch/dinner recipe.`);
    }
    if (!isBreakfast && ingredientCount >= 10 && recipe.prepTimeMinutes < 40) {
      errors.push(`Prep time ${recipe.prepTimeMinutes} min is too low for a recipe with ${ingredientCount} ingredients (min ~40 min).`);
    }
  }

  // Placeholder validation: every {placeholder} in the body must match an ingredient name
  if (recipe.body) {
    const placeholders = recipe.body.match(/\{([^}]+)\}/g) ?? [];
    const ingredientNames = new Set(
      (recipe.ingredients ?? []).map((ing) => ing.name.toLowerCase())
    );
    for (const ph of placeholders) {
      const name = ph.slice(1, -1).toLowerCase(); // strip { }
      if (!ingredientNames.has(name)) {
        errors.push(`Placeholder ${ph} in recipe body does not match any ingredient name.`);
      }
    }
  }

  // Short name validation
  if (!recipe.shortName) {
    warnings.push('Missing short_name (recommended for compact display).');
  }
  if (recipe.shortName && recipe.shortName.length > 25) {
    errors.push(`short_name "${recipe.shortName}" exceeds 25 chars (${recipe.shortName.length}).`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
