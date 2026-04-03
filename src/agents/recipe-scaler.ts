/**
 * Recipe scaler sub-agent.
 *
 * Scales an existing recipe to hit different calorie/protein targets. Uses the
 * ingredient role system to decide what to adjust:
 * - carb role: adjust first (main calorie lever)
 * - fat role: adjust second
 * - protein role: adjust last (protect protein)
 * - vegetable/base/seasoning: keep stable
 *
 * Uses GPT-5.4-mini (mini model) because scaling is a more mechanical task
 * than recipe creation.
 *
 * Returns scaled ingredient amounts — the recipe structure stays the same.
 */

import type { LLMProvider } from '../ai/provider.js';
import type { Recipe, ScaledIngredient } from '../models/types.js';

export interface ScaleRecipeInput {
  recipe: Recipe;
  targetCalories: number;
  targetProtein: number;
  servings: number;
}

export interface ScaleRecipeOutput {
  scaledIngredients: ScaledIngredient[];
  actualPerServing: {
    calories: number;
    protein: number;
    fat: number;
    carbs: number;
  };
}

/**
 * Scale a recipe's ingredients to hit new macro targets.
 *
 * @param input - Original recipe, target macros, and number of servings
 * @param llm - LLM provider for the scaling calculation
 * @returns Scaled ingredients with per-batch totals, and actual macros achieved
 */
export async function scaleRecipe(
  input: ScaleRecipeInput,
  llm: LLMProvider,
): Promise<ScaleRecipeOutput> {
  const { recipe, targetCalories, targetProtein, servings } = input;

  const systemPrompt = `You scale recipe ingredients to hit new nutritional targets.

SCALING RULES (by ingredient role):
- "carb" ingredients: adjust FIRST — they are the main calorie lever
- "fat" ingredients: adjust SECOND
- "protein" ingredients: adjust LAST — protect protein
- "vegetable", "base", "seasoning": keep STABLE (do not change amounts)

Respond with ONLY valid JSON:
{
  "scaled_ingredients": [
    { "name": "string", "amount": number, "unit": "string", "total_for_batch": number }
  ],
  "actual_per_serving": { "calories": number, "protein": number, "fat": number, "carbs": number }
}

"amount" = per-serving amount after scaling.
"total_for_batch" = amount × ${servings} (number of servings).
"actual_per_serving" = your best estimate of the resulting macros after scaling.`;

  const ingredientList = recipe.ingredients
    .map((ing) => `- ${ing.name}: ${ing.amount}${ing.unit} (role: ${ing.role})`)
    .join('\n');

  const userPrompt = `Scale this recipe:

"${recipe.name}" — currently ${recipe.perServing.calories} cal, ${recipe.perServing.protein}g protein per serving.

Ingredients (per serving):
${ingredientList}

NEW TARGET per serving:
- Calories: ${targetCalories} kcal
- Protein: ${targetProtein}g

Number of servings: ${servings}

Adjust ingredients to hit the new targets following the scaling rules.`;

  const result = await llm.complete({
    model: 'mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    json: true,
    reasoning: 'low',
    context: 'recipe-scaling',
  });

  const parsed = JSON.parse(result.content);
  return {
    scaledIngredients: parsed.scaled_ingredients.map((ing: Record<string, unknown>) => ({
      name: ing.name as string,
      amount: ing.amount as number,
      unit: ing.unit as string,
      totalForBatch: ing.total_for_batch as number,
    })),
    actualPerServing: {
      calories: parsed.actual_per_serving.calories,
      protein: parsed.actual_per_serving.protein,
      fat: parsed.actual_per_serving.fat,
      carbs: parsed.actual_per_serving.carbs,
    },
  };
}
