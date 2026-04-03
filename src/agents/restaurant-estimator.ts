/**
 * Restaurant estimator sub-agent.
 *
 * Estimates calories and protein for restaurant or social meals based on
 * a text description. Uses GPT-5.4-mini because estimation is a lighter task.
 *
 * The user describes an upcoming meal ("Thursday dinner out, Italian place,
 * probably pasta and wine") and this agent returns a calorie estimate with
 * a confidence level. The estimate is used by the solver at planning time.
 *
 * In v0.0.1, only text/voice descriptions are supported. Photo-based
 * estimation is planned for v0.0.2.
 */

import type { LLMProvider } from '../ai/provider.js';

export interface RestaurantEstimateInput {
  /** Free-form description of the meal ("Italian dinner, probably carbonara and wine") */
  description: string;
  /** Which meal this replaces */
  mealTime: 'lunch' | 'dinner';
}

export interface RestaurantEstimateOutput {
  estimatedCalories: number;
  estimatedProtein: number;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

/**
 * Estimate calories and protein for a restaurant/social meal.
 *
 * @param input - Meal description and meal time
 * @param llm - LLM provider for estimation
 * @returns Calorie/protein estimate with confidence level
 */
export async function estimateRestaurantMeal(
  input: RestaurantEstimateInput,
  llm: LLMProvider,
): Promise<RestaurantEstimateOutput> {
  const systemPrompt = `You estimate calories and protein for restaurant/social meals.

Given a description of an upcoming meal, provide your best estimate.

GUIDELINES:
- Be realistic — restaurant portions are typically larger than home-cooked.
- Include likely appetizers, drinks, and dessert if the description suggests a full dinner out.
- Alcohol calories count if mentioned (but never suggest alcohol).
- For vague descriptions, estimate on the higher side — it's better to overbudget than underbudget.
- Protein estimates should be conservative.

CONFIDENCE LEVELS:
- "high": Specific dish mentioned (e.g., "carbonara at restaurant X")
- "medium": Cuisine and meal type clear (e.g., "Italian dinner")
- "low": Very vague (e.g., "dinner with friends")

Respond with ONLY valid JSON:
{
  "estimated_calories": number,
  "estimated_protein": number,
  "confidence": "low" | "medium" | "high",
  "reasoning": "brief explanation of the estimate"
}`;

  const userPrompt = `Estimate this upcoming ${input.mealTime}:

"${input.description}"`;

  const result = await llm.complete({
    model: 'mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    json: true,
    reasoning: 'low',
  });

  const parsed = JSON.parse(result.content);
  return {
    estimatedCalories: parsed.estimated_calories,
    estimatedProtein: parsed.estimated_protein,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  };
}
