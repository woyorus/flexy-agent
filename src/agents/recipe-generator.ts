/**
 * Recipe generator sub-agent.
 *
 * Generates new recipes that hit specific calorie/protein targets. Runs with
 * an isolated context — receives a focused task, does deep work, returns a
 * condensed result (the structured recipe).
 *
 * Uses GPT-5.4 (primary model) because recipe generation requires creative
 * reasoning about ingredient combinations and nutritional balance.
 *
 * The orchestrator never sees this agent's full working context. It only
 * receives the final Recipe object.
 *
 * Not responsible for: deciding what to generate (orchestrator does that),
 * validating the recipe (QA gate does that), scaling existing recipes
 * (recipe scaler does that).
 */

import type { LLMProvider } from '../ai/provider.js';
import type { Recipe, Macros } from '../models/types.js';
import { config } from '../config.js';

export interface GenerateRecipeInput {
  /** Target calories per serving — hard constraint */
  targetCalories: number;
  /** Target protein per serving — hard constraint */
  targetProtein: number;
  mealType: 'breakfast' | 'lunch' | 'dinner';
  /** Optional cuisine or ingredient preference from the user */
  cuisineHint?: string;
  /** Slugs to avoid repeating */
  excludeSlugs?: string[];
}

/**
 * Generate a new recipe hitting the specified macro targets.
 *
 * @param input - Target macros, meal type, and preferences
 * @param llm - LLM provider for generation
 * @returns A complete Recipe object ready for validation and storage
 */
export async function generateRecipe(
  input: GenerateRecipeInput,
  llm: LLMProvider,
): Promise<Recipe> {
  const systemPrompt = `You are a recipe creation assistant for a meal prep system.
You create recipes that hit specific nutritional targets.

RULES:
- The recipe MUST hit the calorie and protein targets within ±5%.
- Fat and carbs should be balanced reasonably (you decide the split).
- Internal targets for fat: ~${config.targets.daily.fat}g/day, carbs: ~${config.targets.daily.carbs}g/day. Scale proportionally to the calorie target.
- Recipes should be practical for meal prep: one-pan/one-pot preferred.
- Every ingredient must have a role: protein, carb, fat, vegetable, base, or seasoning.
- Include prep time, storage info (fridge days, freezable, reheat instructions).
- Respond with ONLY valid JSON matching the schema below. No markdown, no explanation.

JSON Schema:
{
  "name": "string",
  "slug": "string (kebab-case)",
  "meal_types": ["lunch" | "dinner" | "breakfast"],
  "cuisine": "string",
  "tags": ["string"],
  "prep_time_minutes": number,
  "per_serving": { "calories": number, "protein": number, "fat": number, "carbs": number },
  "ingredients": [{ "name": "string", "amount": number, "unit": "string", "role": "protein|carb|fat|vegetable|base|seasoning" }],
  "storage": { "fridge_days": number, "freezable": boolean, "reheat": "string" },
  "steps": "string (numbered steps)",
  "notes": "string (optional tips)"
}`;

  const userPrompt = buildUserPrompt(input);

  const result = await llm.complete({
    model: 'primary',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    json: true,
    reasoning: 'medium',
  });

  const parsed = JSON.parse(result.content);
  return mapToRecipe(parsed);
}

function buildUserPrompt(input: GenerateRecipeInput): string {
  let prompt = `Generate a ${input.mealType} recipe.

Target per serving:
- Calories: ${input.targetCalories} kcal
- Protein: ${input.targetProtein}g`;

  if (input.cuisineHint) {
    prompt += `\n\nPreference: ${input.cuisineHint}`;
  }

  if (input.excludeSlugs?.length) {
    prompt += `\n\nAvoid these recipes (already planned): ${input.excludeSlugs.join(', ')}`;
  }

  prompt += `\n\nMake it practical for meal prep (3 servings, stores well in fridge for 3+ days).`;

  return prompt;
}

/** Map raw LLM JSON response to our Recipe interface. */
function mapToRecipe(raw: Record<string, unknown>): Recipe {
  const r = raw as Record<string, any>;
  return {
    name: r.name,
    slug: r.slug,
    mealTypes: r.meal_types,
    cuisine: r.cuisine,
    tags: r.tags ?? [],
    prepTimeMinutes: r.prep_time_minutes,
    perServing: {
      calories: r.per_serving.calories,
      protein: r.per_serving.protein,
      fat: r.per_serving.fat,
      carbs: r.per_serving.carbs,
    },
    ingredients: r.ingredients.map((ing: Record<string, unknown>) => ({
      name: ing.name,
      amount: ing.amount,
      unit: ing.unit,
      role: ing.role,
    })),
    storage: {
      fridgeDays: r.storage.fridge_days,
      freezable: r.storage.freezable,
      reheat: r.storage.reheat,
    },
    steps: r.steps,
    notes: r.notes || undefined,
  };
}
