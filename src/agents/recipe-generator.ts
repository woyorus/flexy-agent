/**
 * Recipe generator sub-agent.
 *
 * Three operations:
 * - generateRecipe(): Create a new recipe from scratch. Returns the recipe + conversation
 *   history (messages array) for future refinement.
 * - refineRecipe(): Make targeted edits to an existing recipe using multi-turn conversation.
 *   Appends the user's edit request to the conversation history so the LLM sees its own
 *   prior output and makes minimal changes instead of regenerating from scratch. Supports
 *   chaining — each call returns updated messages for the next refinement.
 * - correctRecipeMacros(): Fix macro deviations after generation or refinement. Sends specific,
 *   calculated correction instructions (e.g., "you're 35 cal over, reduce olive oil"). Uses
 *   medium reasoning since it's adjusting amounts, not being creative.
 *
 * Generation and refinement use GPT-5.4-mini with high reasoning — good quality at ~10% the cost of primary.
 * Macro correction uses mini with medium reasoning — it's amount adjustment, not creative work.
 *
 * Key design decisions:
 * - Meals are composable: main dish + optional carb side + optional side (not Frankenballs).
 * - Breakfast is component-based: 2-3 distinct components, not everything mixed together.
 * - Steps reference ingredients by name only, never amounts — amounts live in structured
 *   data and are rendered dynamically (supports scaling).
 * - Ingredient roles enable smart scaling: carbs adjust first, fats second, protein last.
 * - All four macros (cal, protein, fat, carbs) are first-class targets.
 *
 * The generator returns a Recipe object. The QA gate validates it before saving.
 */

import type { LLMProvider, ChatMessage } from '../ai/provider.js';
import type { Recipe, RecipeComponent, RecipeIngredient, MacrosWithFatCarbs } from '../models/types.js';
import { config } from '../config.js';

export interface GenerateRecipeInput {
  mealType: 'breakfast' | 'lunch' | 'dinner';
  /** Target macros per serving — all four are constraints */
  targets: MacrosWithFatCarbs;
  /** Optional user preferences: cuisine, simplicity, speed, ingredient requests/avoidances */
  preferences?: string;
}

/** Result of recipe generation — includes conversation history for multi-turn refinement. */
export interface GenerateResult {
  recipe: Recipe;
  /** Full conversation messages used, including the assistant's response. Pass to refineRecipe for follow-up edits. */
  messages: ChatMessage[];
}

/**
 * Generate a new recipe from scratch.
 *
 * @param input - Meal type, macro targets, preferences
 * @param llm - LLM provider (uses mini model with high reasoning — good quality at ~10% the cost of primary)
 * @returns The recipe and the conversation history for future refinement
 */
export async function generateRecipe(
  input: GenerateRecipeInput,
  llm: LLMProvider,
): Promise<GenerateResult> {
  const systemPrompt = buildSystemPrompt(input);
  const userPrompt = buildUserPrompt(input);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const result = await llm.complete({
    model: 'mini',
    messages,
    json: true,
    reasoning: 'high',
    context: 'recipe-generation',
  });

  const parsed = JSON.parse(result.content);
  const recipe = mapToRecipe(parsed);

  // Append assistant response so the history is complete for refinement
  messages.push({ role: 'assistant', content: result.content });

  return { recipe, messages };
}

/**
 * Refine an existing recipe by appending a user edit request to the conversation history.
 *
 * Uses multi-turn context: the LLM sees the original generation request, its own recipe
 * output, and the user's targeted edit. This makes it treat the recipe as its own prior
 * work and apply minimal, targeted changes instead of regenerating from scratch.
 *
 * Supports chaining: each refinement returns updated messages that can be passed to
 * the next refinement, preserving the full edit history.
 *
 * @param previousMessages - Conversation history from generateRecipe or a prior refineRecipe call
 * @param refinementNote - What the user wants to change
 * @param llm - LLM provider (uses mini model with high reasoning)
 * @returns The updated recipe and extended conversation history
 */
export async function refineRecipe(
  previousMessages: ChatMessage[],
  refinementNote: string,
  llm: LLMProvider,
): Promise<GenerateResult> {
  const messages: ChatMessage[] = [
    ...previousMessages,
    {
      role: 'user',
      content: `${refinementNote}

IMPORTANT: Change ONLY what I'm asking above. Keep all other ingredients, amounts, steps, and structure exactly the same. If this change affects macros, make the smallest possible adjustment — prefer adjusting the carb side quantity — to stay within the original targets.`,
    },
  ];

  const result = await llm.complete({
    model: 'mini',
    messages,
    json: true,
    reasoning: 'high',
    context: 'recipe-refinement',
  });

  const parsed = JSON.parse(result.content);
  const recipe = mapToRecipe(parsed);

  messages.push({ role: 'assistant', content: result.content });

  return { recipe, messages };
}

/**
 * Send macro correction instructions to the LLM after a recipe fails validation.
 *
 * Appends a correction message to the conversation history with specific numbers
 * (how far off, which direction, which ingredients to adjust). The LLM adjusts
 * amounts while keeping the recipe structure and identity intact.
 *
 * @param previousMessages - Conversation history including the off-target recipe
 * @param correctionPrompt - Specific correction instructions built by the flow
 * @param llm - LLM provider (uses mini model with medium reasoning)
 * @returns The corrected recipe and extended conversation history
 */
export async function correctRecipeMacros(
  previousMessages: ChatMessage[],
  correctionPrompt: string,
  llm: LLMProvider,
): Promise<GenerateResult> {
  const messages: ChatMessage[] = [
    ...previousMessages,
    { role: 'user', content: correctionPrompt },
  ];

  const result = await llm.complete({
    model: 'mini',
    messages,
    json: true,
    reasoning: 'medium',
    context: 'macro-correction',
  });

  const parsed = JSON.parse(result.content);
  const recipe = mapToRecipe(parsed);

  messages.push({ role: 'assistant', content: result.content });

  return { recipe, messages };
}

function buildSystemPrompt(input: GenerateRecipeInput): string {
  const isBreakfast = input.mealType === 'breakfast';

  return `You are an expert chef and nutritionist who creates macro-controlled meal prep recipes.

YOUR JOB: Create a recipe that hits specific macro targets while being delicious, practical, and easy to cook.

## MACRO TARGETS (per serving)
- Calories: ${input.targets.calories} kcal (allowed range: ${Math.round(input.targets.calories * 0.97)}-${Math.round(input.targets.calories * 1.03)})
- Protein: ${input.targets.protein}g (allowed range: ${Math.round(input.targets.protein * 0.93)}-${Math.round(input.targets.protein * 1.07)})
- Fat: ${input.targets.fat}g (allowed range: ${Math.round(input.targets.fat * 0.85)}-${Math.round(input.targets.fat * 1.15)})
- Carbs: ${input.targets.carbs}g (allowed range: ${Math.round(input.targets.carbs * 0.85)}-${Math.round(input.targets.carbs * 1.15)})

Priority if tradeoffs happen: 1) Calories 2) Protein 3) Fat 4) Carbs.
It is better to slightly undershoot than overshoot. Overshooting kills caloric deficit.

## MEAL STRUCTURE RULES

${isBreakfast ? `### Breakfast: component-based
- 2-3 distinct components that stand on their own.
- Example patterns:
  - Eggs (omelette/scrambled) + Toast with topping
  - Oatmeal + Yogurt bowl
  - Avocado toast + Eggs + Small oats/yogurt
- 3-6 ingredients per component. Keep each component simple.
- No "Frankenbowls" — don't shove protein powder into oatmeal with random additions.
- Prep time: 5-15 minutes. Minimal equipment.` : `### Lunch/Dinner: composable meal
- The meal has clear, separable parts:
  - MAIN: The hero dish. Protein + vegetables + cooking technique + flavor profile. Must have a clear identity (e.g., "chicken pepperonata", "salmon with green beans", "pork stir-fry").
  - CARB SIDE (often separate): Rice, pasta, potatoes, bread. Cooked independently. Simple.
  - SIDE (optional): Salad, steamed vegetables. Dead simple.
- The main dish has 6-10 ingredients. Cohesive flavor profile. Not random ingredient dumping.
- The carb side is the natural calorie scaling lever — easily adjusted without breaking the dish.
- Must reheat well and hold 2-3 days in the fridge. Storage and reheating instructions required.
- Prep time must be REALISTIC for a home cook, not a professional. Include ALL time: washing, chopping, heating pans, browning, simmering, boiling water, cooking sides, plating. People consistently underestimate cook times. Use these minimums:
  - Simple stir-fry: 25-35 min
  - Pasta dish (boil water + sauce): 35-45 min
  - Skillet/sauté with sauce + side: 40-55 min
  - Bolognese, stew, tagine, curry: 50-70 min
  - Traybake/sheet pan: 40-55 min (includes oven preheat)
  - Anything with 10+ ingredients: at least 45 min
  When in doubt, round UP.`}

## INGREDIENT RULES
- Use metric grams/ml with exact quantities per serving.
- Every ingredient has a role: protein, carb, fat, vegetable, base, or seasoning.
- Every ingredient belongs to a component (main, carb_side, side, or a breakfast component name).
- Prefer: olive oil, nuts, avocado, fish for fats. Minimize butter, cream, fatty processed meats.
- Keep ultra-processed foods low. Minimize added sugar.
- Be PRECISE about ingredient variants that affect macros. The user will shop for exactly what you specify, and will calculate macros from it. If the fat/calorie content varies significantly by type, you MUST specify which type:
  - Dairy: "cooking cream (20% fat)", "Greek yogurt (2%)", "whole milk", "semi-skimmed milk"
  - Meat: "ground beef (10% fat)", "chicken thigh (skin-on)" vs "chicken breast"
  - Coconut: "coconut milk (full fat)" vs "light coconut milk"
  - Cheese: "mozzarella" vs "light mozzarella", "cream cheese (full fat)"
  - General rule: if two common variants of the same ingredient differ by more than 30% in calories, specify which one. Your macro calculations must match the specific variant you name.

## RECIPE TEXT RULES
- Write the recipe body as natural, human-readable text.
- Include a brief description of the dish (1-2 sentences — what it is, what makes it good).
- Steps are numbered and reference ingredients BY NAME ONLY, never by amount.
  CORRECT: "Season the chicken with salt, pepper, and paprika."
  WRONG: "Season 200g chicken with 5g salt."
  Amounts live in the structured ingredient data, not in the steps — this allows dynamic scaling.
- Include: prep time, equipment needed, storage, reheating instructions.
- Include practical tips or simple variations if relevant.

## OUTPUT FORMAT
Respond with ONLY valid JSON matching this schema:
{
  "name": "string — the dish name, clear identity",
  "slug": "string — kebab-case",
  "meal_types": ["breakfast" | "lunch" | "dinner"],
  "cuisine": "string",
  "tags": ["string"],
  "prep_time_minutes": number,
  "structure": [{ "type": "main"|"carb_side"|"side"|"breakfast_component", "name": "string" }],
  "per_serving": { "calories": number, "protein": number, "fat": number, "carbs": number },
  "ingredients": [{ "name": "string", "amount": number, "unit": "string", "role": "protein|carb|fat|vegetable|base|seasoning", "component": "string — matching a structure name" }],
  "storage": { "fridge_days": number, "freezable": boolean, "reheat": "string" },
  "body": "string — the full recipe text (description + steps + storage notes + tips). Use newlines for formatting. Steps as numbered list. No ingredient amounts in the text."
}`;
}

function buildUserPrompt(input: GenerateRecipeInput): string {
  const parts: string[] = [`Create a ${input.mealType} recipe.`];
  if (input.preferences) {
    parts.push(`\nMy preferences: ${input.preferences}`);
  }
  return parts.join('\n');
}

function mapToRecipe(raw: Record<string, any>): Recipe {
  return {
    name: raw.name,
    slug: raw.slug,
    mealTypes: raw.meal_types,
    cuisine: raw.cuisine,
    tags: raw.tags ?? [],
    prepTimeMinutes: raw.prep_time_minutes,
    structure: (raw.structure ?? []).map((s: Record<string, string>) => ({
      type: s.type,
      name: s.name,
    })) as RecipeComponent[],
    perServing: {
      calories: raw.per_serving.calories,
      protein: raw.per_serving.protein,
      fat: raw.per_serving.fat,
      carbs: raw.per_serving.carbs,
    },
    ingredients: raw.ingredients.map((ing: Record<string, unknown>) => ({
      name: ing.name as string,
      amount: ing.amount as number,
      unit: ing.unit as string,
      role: ing.role as string,
      component: ing.component as string,
    })) as RecipeIngredient[],
    storage: {
      fridgeDays: raw.storage.fridge_days,
      freezable: raw.storage.freezable,
      reheat: raw.storage.reheat,
    },
    body: raw.body.replace(/\\n/g, '\n'),
  };
}
