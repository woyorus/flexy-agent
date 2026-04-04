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
 * Calories have a ± tolerance so the scaler can pick clean, measurable
 * ingredient amounts (45g instead of 47g). LLM macro estimates are ±10% by
 * nature, so precision beyond ~20 cal is illusory anyway. Natural variance
 * across meals is absorbed by the treat budget and feels more human.
 * Protein stays precise — it's a satiety/adherence driver.
 *
 * Uses GPT-5.4-mini (mini model) because scaling is a more mechanical task
 * than recipe creation.
 *
 * Returns scaled ingredient amounts — the recipe structure stays the same.
 */

import type { LLMProvider } from '../ai/provider.js';
import type { Recipe, ScaledIngredient } from '../models/types.js';
import { computeMacroCalorieConsistency, MACRO_CAL_TOLERANCE } from '../qa/validators/recipe.js';
import { log } from '../debug/logger.js';

export interface ScaleRecipeInput {
  recipe: Recipe;
  targetCalories: number;
  /** ± acceptable calorie tolerance. Gives the scaler room for clean amounts. */
  calorieTolerance: number;
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
  const { recipe, targetCalories, calorieTolerance, targetProtein, servings } = input;
  const calLow = targetCalories - calorieTolerance;
  const calHigh = targetCalories + calorieTolerance;

  const systemPrompt = `You scale recipe ingredients to hit new nutritional targets.

SCALING RULES (by ingredient role):
- "carb" ingredients: adjust FIRST — they are the main calorie lever
- "fat" ingredients: adjust SECOND
- "protein" ingredients: adjust LAST — protect protein
- "vegetable", "base", "seasoning": keep STABLE (do not change amounts)

CALORIE TARGET IS A RANGE, NOT A SINGLE NUMBER.
- You have ±${calorieTolerance} cal of headroom around the target.
- Use this headroom to pick CLEAN, MEASURABLE amounts rather than chasing precise numbers:
  * Solids (pasta, rice, meat, vegetables): round to nearest 5g
  * Liquids (oil, milk, stock): round to nearest 5ml
  * Spoons/cups: whole or half units (1 tsp, 1/2 tbsp — not 0.7 tbsp)
- A recipe at 798 or 815 with clean amounts is BETTER than one at 803 with 47g of pasta.
- Natural variance is a feature, not a bug. Do not optimize to hit the exact target.

PROTEIN TARGET IS PRECISE.
- Stay within ±2g of the protein target. Protein matters for satiety.

MACRO/CALORIE CONSISTENCY (CRITICAL):
The actual_per_serving numbers MUST satisfy the Atwater formula:
  calories = 4 × protein_g + 4 × carbs_g + 9 × fat_g
All three macro values must add up to the calorie number. Before returning,
compute 4·protein + 4·carbs + 9·fat yourself and verify it equals calories
(within ~5%). If it doesn't, adjust carbs or fat to make it consistent.

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
- Calories: ${calLow}–${calHigh} kcal (target ${targetCalories}, ±${calorieTolerance})
- Protein: ${targetProtein}g (precise, ±2g)

Number of servings: ${servings}

Adjust ingredients using clean, measurable amounts within the calorie range. Follow the scaling rules (carb → fat → protein).`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];

  let result = await llm.complete({
    model: 'mini',
    messages,
    json: true,
    reasoning: 'low',
    context: 'recipe-scaling',
  });

  let parsed = JSON.parse(result.content);
  let actualPerServing = {
    calories: parsed.actual_per_serving.calories,
    protein: parsed.actual_per_serving.protein,
    fat: parsed.actual_per_serving.fat,
    carbs: parsed.actual_per_serving.carbs,
  };

  // Validate internal macro/calorie consistency (Atwater: 4P + 4C + 9F = cal).
  // LLMs frequently return incoherent numbers — retry once with the exact correction.
  const consistency = computeMacroCalorieConsistency(actualPerServing);
  if (consistency.deviationPct > MACRO_CAL_TOLERANCE) {
    log.warn('SCALER', `macro/calorie mismatch for ${recipe.slug}: stated ${actualPerServing.calories} vs computed ${consistency.computed} (off ${(consistency.deviationPct * 100).toFixed(1)}%). Retrying.`);

    result = await llm.complete({
      model: 'mini',
      messages: [
        ...messages,
        { role: 'assistant' as const, content: result.content },
        {
          role: 'user' as const,
          content: `Your actual_per_serving numbers don't add up via Atwater factors: stated ${actualPerServing.calories} cal but ${actualPerServing.protein}g P × 4 + ${actualPerServing.carbs}g C × 4 + ${actualPerServing.fat}g F × 9 = ${consistency.computed} cal (off by ${(consistency.deviationPct * 100).toFixed(1)}%). The numbers MUST satisfy: calories = 4·protein + 4·carbs + 9·fat. Recompute and return the full corrected JSON with consistent values. Keep calories within the same target range (${calLow}–${calHigh}).`,
        },
      ],
      json: true,
      reasoning: 'low',
      context: 'recipe-scaling-retry',
    });

    parsed = JSON.parse(result.content);
    actualPerServing = {
      calories: parsed.actual_per_serving.calories,
      protein: parsed.actual_per_serving.protein,
      fat: parsed.actual_per_serving.fat,
      carbs: parsed.actual_per_serving.carbs,
    };

    const retryConsistency = computeMacroCalorieConsistency(actualPerServing);
    if (retryConsistency.deviationPct > MACRO_CAL_TOLERANCE) {
      log.error('SCALER', `retry also produced inconsistent macros for ${recipe.slug}: ${actualPerServing.calories} vs ${retryConsistency.computed} (${(retryConsistency.deviationPct * 100).toFixed(1)}%). Proceeding with best effort.`);
    }
  }

  return {
    scaledIngredients: parsed.scaled_ingredients.map((ing: Record<string, unknown>) => ({
      name: ing.name as string,
      amount: ing.amount as number,
      unit: ing.unit as string,
      totalForBatch: ing.total_for_batch as number,
    })),
    actualPerServing,
  };
}
