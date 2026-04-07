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

function mealTypeSection(mealType: 'breakfast' | 'lunch' | 'dinner'): string {
  if (mealType === 'breakfast') {
    return `### Breakfast: component-based
- 2-3 distinct components that stand on their own.
- Example patterns:
  - Eggs (omelette/scrambled) + Toast with topping
  - Oatmeal + Yogurt bowl
  - Avocado toast + Eggs + Small oats/yogurt
- 3-6 ingredients per component. Keep each component simple.
- No "Frankenbowls" — don't shove protein powder into oatmeal with random additions.
- Prep time: 5-15 minutes. Minimal equipment.`;
  }

  if (mealType === 'lunch') {
    return `### Lunch: light, practical, one-container meals
- Lunches are eaten during the day, often reheated at work. They should be LIGHTER in character than dinner — not heavy pasta dishes or rich stews.
- Preferred styles:
  - GRAIN/RICE BOWLS: Protein + vegetables + grain base + light dressing/sauce. The default lunch format.
  - SALADS WITH WARM PROTEIN: Hearty salads with grilled chicken, fish, or legumes. Not sad diet salads — filling and satisfying.
  - LIGHTER STEWS/SOUPS: Lentil soups, chicken and vegetable stews, lighter curries. Not heavy cream-based.
  - WRAPS/STUFFED MEALS: When practical and reheatable.
- The meal has clear, separable parts:
  - MAIN: Protein + vegetables with a light sauce or dressing. Clear identity (e.g., "lemon herb chicken", "sesame tofu and vegetables").
  - BASE (often separate): Rice, quinoa, couscous, bulgur, or mixed grains.
  - SIDE (optional): Fresh component — salad, pickled vegetables, salsa.
- Sauces should be LIGHT: vinaigrettes, tahini, soy-based, salsa, lemon-herb. Avoid heavy cream sauces, cheese-heavy preparations, or rich meat gravies for lunch.
- Must be microwave-friendly and hold 2-3 days in the fridge. One-container packing preferred.
- Do NOT default to pasta, bolognese, traybakes, or other dinner-style meals unless the user specifically asks for them.
- 6-10 ingredients in the main. Cohesive flavor profile.
- The base (grain/rice) is the natural calorie scaling lever.
- Prep time must be REALISTIC. Minimums:
  - Simple bowl assembly (pre-cooked protein + grain): 25-35 min
  - Skillet protein + grain side: 35-45 min
  - Anything with 10+ ingredients: at least 40 min
  When in doubt, round UP.`;
  }

  // dinner
  return `### Dinner: hearty, satisfying sit-down meals
- Dinners are the main meal of the day, eaten at home. They should be HEARTIER and more comforting than lunch.
- Preferred styles:
  - PASTA DISHES: Bolognese, carbonara-style, linguine, rigatoni with rich sauces.
  - SKILLET/SAUTÉ MEALS: Pan-cooked protein with vegetables and a flavorful sauce.
  - TRAYBAKES: Sheet pan meals — protein and vegetables roasted together.
  - STEWS/CURRIES/TAGINES: Slow-cooked or simmered dishes with depth of flavor.
- The meal has clear, separable parts:
  - MAIN: The hero dish. Protein + vegetables + cooking technique + rich flavor profile. Must have a clear identity (e.g., "chicken pepperonata", "salmon traybake", "beef tagine").
  - CARB SIDE (often separate): Pasta, rice, potatoes, couscous, bread. Cooked independently. Simple.
  - SIDE (optional): Salad, steamed vegetables. Dead simple.
- Richer sauces and preparations are welcome: cream-based, cheese, slow-cooked tomato, wine-reduced, butter-finished.
- The main dish has 6-10 ingredients. Cohesive flavor profile. Not random ingredient dumping.
- The carb side is the natural calorie scaling lever — easily adjusted without breaking the dish.
- Must reheat well and hold 2-3 days in the fridge. Storage and reheating instructions required.
- Prep time must be REALISTIC for a home cook. Minimums:
  - Simple stir-fry: 25-35 min
  - Pasta dish (boil water + sauce): 35-45 min
  - Skillet/sauté with sauce + side: 40-55 min
  - Bolognese, stew, tagine, curry: 50-70 min
  - Traybake/sheet pan: 40-55 min (includes oven preheat)
  - Anything with 10+ ingredients: at least 45 min
  When in doubt, round UP.`;
}

export function buildSystemPrompt(input: GenerateRecipeInput): string {
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

${mealTypeSection(input.mealType)}

## INGREDIENT RULES
- Use metric grams/ml with exact quantities per serving — EXCEPT for naturally countable items.
- **Countable items use whole units, not grams.** The user can't weigh an egg.
  - Eggs: "2 eggs" (unit: "whole"), NOT "90g eggs"
  - Limes/lemons: "1 lime" (unit: "whole") or "juice of 1 lime" — NOT "30g lime"
  - Garlic: "2 cloves" (unit: "cloves"), NOT "6g garlic"
  - Bananas, avocados, onions: use count or fraction ("1 avocado", "½ onion") when the natural unit is obvious
  - For macro calculations, use standard sizes: 1 large egg ≈ 60g, 1 clove garlic ≈ 3g, 1 medium avocado ≈ 150g flesh
- **ALL amounts must be RAW / UNCOOKED / DRY weight.** This is critical for accurate macro counting and shopping.
  - Meat and fish: RAW weight (e.g., "chicken breast, raw: 200g")
  - Pasta, rice, grains: DRY/UNCOOKED weight (e.g., "rigatoni, dry: 65g", "jasmine rice, uncooked: 80g")
  - Legumes: DRAINED weight for canned (e.g., "canned chickpeas, drained: 100g"), DRY weight for dried
  - Vegetables: raw/uncooked weight
  - Your macro calculations MUST be based on the raw/dry weights you specify. Do NOT calculate macros from cooked weights.
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

## USER FOOD PROFILE
The user lives in ${config.foodProfile.region}. Shopping access: ${config.foodProfile.storeAccess}
${config.foodProfile.ingredientNotes}
${config.foodProfile.avoided.length > 0 ? `Avoided ingredients: ${config.foodProfile.avoided.join(', ')}` : ''}
ALL ingredient choices must respect this profile. Do not suggest ingredients the user cannot easily find in their local stores.

## RECIPE TEXT RULES
- Write the recipe body as natural, human-readable text.
- Include a brief description of the dish (1-2 sentences — what it is, what makes it good).
- Steps are numbered and use \`{ingredient_name}\` placeholders for amounts:
  CORRECT: "Cook {penne pasta} until al dente, **10-11 min**."
  CORRECT: "Heat {olive oil} in a large skillet."
  WRONG: "Cook 65g penne pasta until al dente." (hardcoded amount)
  WRONG: "Cook the pasta until al dente." (no placeholder — user can't know the amount)
  The placeholder name MUST exactly match an ingredient's \`name\` field in the ingredients array.
  "To-taste" seasoning — ingredients that a cook applies freely without measuring (salt, pepper,
  chili flakes) — stay as-is in prose even though they have YAML amounts. No placeholder.
  Use \`role: seasoning\` as the signal: if it's a role-seasoning ingredient with a small nominal
  YAML amount (e.g., 1g salt, 0.5g pepper) that doesn't materially affect macros, treat it as to-taste.
  Only ingredients whose amount directly affects macros or cooking outcome get a placeholder:
  proteins, carbs, oils, specific spices in meaningful amounts (e.g., "2 tsp smoked paprika")
  → those DO get a placeholder: "Add {smoked paprika}, stir **1 min**."
- Every heat step MUST include an explicit duration:
  CORRECT: "Sear salmon cubes without moving, **2 min per side**."
  CORRECT: "Cook **4-5 min** until softened."
  WRONG: "Cook until golden." (no time anchor)
  WRONG: "Simmer until thickened." (needs "**15-20 min** until thickened")
- Group to-taste seasonings on one line in the prose:
  CORRECT: "Season with salt, pepper, and chili flakes."
  WRONG: "Add the salt. Add the pepper. Add the chili flakes." (three lines for to-taste items)
  Only seasonings with specific amounts (e.g., "2 tsp smoked paprika") get called out individually.
- Include: prep time, equipment needed, storage, reheating instructions.
- Include practical tips or simple variations if relevant.

## OUTPUT FORMAT
Respond with ONLY valid JSON matching this schema:
{
  "name": "string — the dish name, clear identity",
  "short_name": "string — max 25 chars, 2-3 word recognizable identity (e.g., 'Beef Tagine', 'Salmon Pasta')",
  "slug": "string — kebab-case, max 50 chars (e.g. 'chicken-pepperonata-rice', not 'chicken-pepperonata-with-rice-and-roasted-vegetables-mediterranean-style')",
  "meal_types": ["breakfast" | "lunch" | "dinner"],
  "cuisine": "string",
  "tags": ["string"],
  "prep_time_minutes": number,
  "structure": [{ "type": "main"|"carb_side"|"side"|"breakfast_component", "name": "string" }],
  "per_serving": { "calories": number, "protein": number, "fat": number, "carbs": number },
  "ingredients": [{ "name": "string", "amount": number, "unit": "string", "role": "protein|carb|fat|vegetable|base|seasoning", "component": "string — matching a structure name" }],
  "storage": { "fridge_days": number, "freezable": boolean, "reheat": "string" },
  "body": "string — the full recipe text (description + steps + storage notes + tips). Use {ingredient_name} placeholders in steps (see RECIPE TEXT RULES). Use newlines for formatting. Steps as numbered list."
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
    ...(raw.short_name !== undefined && { shortName: raw.short_name as string }),
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
