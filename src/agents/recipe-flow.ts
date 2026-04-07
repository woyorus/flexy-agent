/**
 * Recipe generation flow handler.
 *
 * A focused, self-contained flow for generating recipes through Telegram.
 * Separated from the planning flow — recipe generation is its own product process.
 *
 * Flow:
 * 1. User initiates (via "My Recipes" -> "Add new recipe", or direct description)
 * 2. If meal type not specified, ask: Breakfast / Lunch / Dinner
 * 3. User optionally describes preferences (text or voice)
 * 4. System generates recipe with full detail -> shows rendered recipe
 * 5. User reviews: Save / Refine / New recipe / Discard
 * 6. If Refine: user describes what to change -> regenerate -> back to step 5
 * 7. If Save: store to database, done
 *
 * Uses the recipe generator sub-agent with GPT-5.4 high reasoning.
 * Uses the recipe renderer for Telegram display.
 *
 * All flow state transitions and validation results are logged via the
 * debug logger for post-session analysis.
 */

import type { LLMProvider } from '../ai/provider.js';
import type { Recipe, MacrosWithFatCarbs } from '../models/types.js';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import { generateRecipe, refineRecipe, correctRecipeMacros, buildSystemPrompt, type GenerateResult, type GenerateRecipeInput } from './recipe-generator.js';
import { RecipeDatabase } from '../recipes/database.js';
import type { ChatMessage } from '../ai/provider.js';
import { renderRecipe } from '../recipes/renderer.js';
import { validateRecipe, computeMacroCalorieConsistency, MACRO_CAL_TOLERANCE } from '../qa/validators/recipe.js';

const MAX_CORRECTION_RETRIES = 2;

/** Intent classification result for messages sent during recipe review. */
export type ReviewIntent = 'question' | 'refinement';

/** State for an in-progress recipe generation session. */
export interface RecipeFlowState {
  phase: 'choose_meal_type' | 'awaiting_preferences' | 'reviewing' | 'awaiting_refinement';
  mealType?: 'breakfast' | 'lunch' | 'dinner';
  preferences?: string;
  currentRecipe?: Recipe;
  /** Conversation history with the LLM — used for multi-turn refinement so the model preserves context. */
  conversationHistory?: ChatMessage[];
}

export function createRecipeFlowState(): RecipeFlowState {
  return { phase: 'choose_meal_type' };
}

/**
 * Create a recipe flow state for editing an existing recipe.
 * Seeds the conversation history so the LLM sees the recipe as its own prior
 * output and makes targeted changes instead of regenerating from scratch.
 */
export function createEditFlowState(recipe: Recipe): RecipeFlowState {
  const mealType = recipe.mealTypes[0] ?? 'dinner';
  const targets = targetsForMealType(mealType);

  // Reconstruct a minimal conversation history: system prompt + user request + recipe as assistant output
  const systemPrompt = buildSystemPrompt({ mealType, targets });
  const recipeJson = JSON.stringify(recipeToRawJson(recipe));

  return {
    phase: 'awaiting_refinement',
    mealType,
    currentRecipe: recipe,
    conversationHistory: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Create a ${mealType} recipe.` },
      { role: 'assistant', content: recipeJson },
    ],
  };
}

/** Convert a Recipe back to the raw JSON format the LLM produces. */
function recipeToRawJson(recipe: Recipe): Record<string, unknown> {
  return {
    name: recipe.name,
    ...(recipe.shortName !== undefined && { short_name: recipe.shortName }),
    slug: recipe.slug,
    meal_types: recipe.mealTypes,
    cuisine: recipe.cuisine,
    tags: recipe.tags,
    prep_time_minutes: recipe.prepTimeMinutes,
    structure: recipe.structure.map((s) => ({ type: s.type, name: s.name })),
    per_serving: recipe.perServing,
    ingredients: recipe.ingredients.map((i) => ({
      name: i.name, amount: i.amount, unit: i.unit, role: i.role, component: i.component,
    })),
    storage: {
      fridge_days: recipe.storage.fridgeDays,
      freezable: recipe.storage.freezable,
      reheat: recipe.storage.reheat,
    },
    body: recipe.body,
  };
}

/** Macro targets per meal type, derived from daily targets. */
export function targetsForMealType(mealType: 'breakfast' | 'lunch' | 'dinner'): MacrosWithFatCarbs {
  const d = config.targets.daily;
  if (mealType === 'breakfast') {
    // Breakfast: ~27% of daily
    return {
      calories: Math.round(d.calories * 0.27),
      protein: Math.round(d.protein * 0.27),
      fat: Math.round(d.fat * 0.27),
      carbs: Math.round(d.carbs * 0.27),
    };
  }
  // Lunch/dinner: 33% each (5% treat budget + 2% flex bonus account for the rest)
  const remaining = 0.33; // each gets ~33% (804 cal at 2,436 daily)
  return {
    calories: Math.round(d.calories * remaining),
    protein: Math.round(d.protein * remaining),
    fat: Math.round(d.fat * remaining),
    carbs: Math.round(d.carbs * remaining),
  };
}

/**
 * Build a correction prompt for the LLM if the recipe fails validation.
 * Returns null if everything is within tolerance.
 *
 * Checks:
 * - Calories: ±3% (weight loss product — overshooting kills caloric deficit)
 * - Protein: ±5%
 * - Macro/calorie consistency: ±5% (stated cal must match 4P+4C+9F Atwater formula)
 * - Prep time: minimum thresholds based on ingredient count and meal type
 */
function buildCorrectionPrompt(recipe: Recipe, targets: MacrosWithFatCarbs): string | null {
  const macroIssues: string[] = [];
  const otherIssues: string[] = [];

  // Macro checks
  const calDelta = recipe.perServing.calories - targets.calories;
  const calDevPct = Math.abs(calDelta) / targets.calories;
  if (calDevPct > 0.03) {
    const dir = calDelta > 0 ? 'over' : 'under';
    macroIssues.push(`- Calories: ${recipe.perServing.calories} cal (${dir} by ${Math.abs(Math.round(calDelta))} cal, target: ${targets.calories})`);
  }

  const protDelta = recipe.perServing.protein - targets.protein;
  const protDevPct = Math.abs(protDelta) / targets.protein;
  if (protDevPct > 0.05) {
    const dir = protDelta > 0 ? 'over' : 'under';
    macroIssues.push(`- Protein: ${recipe.perServing.protein}g (${dir} by ${Math.abs(Math.round(protDelta))}g, target: ${targets.protein}g)`);
  }

  // Internal consistency: stated calories must match Atwater computation
  const consistency = computeMacroCalorieConsistency(recipe.perServing);
  if (consistency.deviationPct > MACRO_CAL_TOLERANCE) {
    macroIssues.push(
      `- Macro/calorie mismatch: stated ${recipe.perServing.calories} cal vs computed ${consistency.computed} cal from macros (${recipe.perServing.protein}g P × 4 + ${recipe.perServing.carbs}g C × 4 + ${recipe.perServing.fat}g F × 9), off by ${(consistency.deviationPct * 100).toFixed(1)}%. The numbers MUST add up via Atwater factors.`
    );
  }

  // Prep time check
  const ingredientCount = recipe.ingredients?.length ?? 0;
  const isBreakfast = recipe.mealTypes?.includes('breakfast');
  if (!isBreakfast && recipe.prepTimeMinutes < 25) {
    otherIssues.push(`- Prep time: ${recipe.prepTimeMinutes} min is unrealistically low for a lunch/dinner recipe. Be honest about total time including chopping, heating, cooking, and side prep.`);
  } else if (!isBreakfast && ingredientCount >= 10 && recipe.prepTimeMinutes < 40) {
    otherIssues.push(`- Prep time: ${recipe.prepTimeMinutes} min is too low for a recipe with ${ingredientCount} ingredients. Include all time: chopping, heating pans, browning, simmering, cooking sides. Minimum ~40-50 min for this complexity.`);
  }

  if (macroIssues.length === 0 && otherIssues.length === 0) return null;

  let prompt = 'CORRECTIONS NEEDED:\n';

  if (macroIssues.length > 0) {
    prompt += `\nMACRO ISSUES:\n${macroIssues.join('\n')}\n`;
    prompt += `\nFix macros by adjusting ingredient AMOUNTS ONLY. Priority:
1. Fat ingredients first (olive oil, butter, cheese, cream) — highest cal/gram
2. Carb side quantity (pasta, rice, potatoes, bread) — easy scaling lever
3. NEVER reduce the protein source amount
4. NEVER change ingredients the user specifically asked for

CRITICAL: The final per_serving numbers must satisfy Atwater:
  calories = 4 × protein_g + 4 × carbs_g + 9 × fat_g
All three macro values must add up to the calorie number. Recompute carefully.
Better to slightly undershoot calories than overshoot.\n`;
  }

  if (otherIssues.length > 0) {
    prompt += `\nOTHER ISSUES:\n${otherIssues.join('\n')}\n`;
  }

  prompt += '\nRespond with the full corrected recipe JSON.';
  return prompt;
}

/**
 * Run the generate->validate->correct loop.
 *
 * After the LLM produces a recipe (either fresh or refined), check macros against
 * targets. If off, send specific correction instructions and retry up to MAX_CORRECTION_RETRIES
 * times. Returns the best result and whether it passed validation.
 */
async function validateAndCorrect(
  result: GenerateResult,
  targets: MacrosWithFatCarbs,
  llm: LLMProvider,
): Promise<{ result: GenerateResult; passed: boolean; warnings: string[] }> {
  let current = result;

  for (let attempt = 0; attempt < MAX_CORRECTION_RETRIES; attempt++) {
    const correction = buildCorrectionPrompt(current.recipe, targets);
    if (!correction) {
      // Macros are within tolerance
      const validation = validateRecipe(current.recipe, { calories: targets.calories, protein: targets.protein });
      log.debug('QA', `recipe validation: PASS — ${current.recipe.perServing.calories} cal (target ${targets.calories}), ${current.recipe.perServing.protein}g P (target ${targets.protein})`);
      return { result: current, passed: true, warnings: validation.warnings };
    }

    log.debug('QA', `macro correction attempt ${attempt + 1}/${MAX_CORRECTION_RETRIES} — current: ${current.recipe.perServing.calories} cal, ${current.recipe.perServing.protein}g P | target: ${targets.calories} cal, ${targets.protein}g P`);
    log.addOperationEvent(`correction ${attempt + 1}/${MAX_CORRECTION_RETRIES}`);

    current = await correctRecipeMacros(current.messages, correction, llm);
  }

  // Check one more time after final correction
  const finalCorrection = buildCorrectionPrompt(current.recipe, targets);
  const validation = validateRecipe(current.recipe, { calories: targets.calories, protein: targets.protein });
  const passed = finalCorrection === null;

  if (passed) {
    log.debug('QA', `recipe validation after corrections: PASS — ${current.recipe.perServing.calories} cal, ${current.recipe.perServing.protein}g P`);
  } else {
    log.warn('QA', `recipe validation: FAIL after ${MAX_CORRECTION_RETRIES} corrections — ${current.recipe.perServing.calories} cal (target ${targets.calories}), ${current.recipe.perServing.protein}g P (target ${targets.protein}). Showing best effort.`);
  }

  if (validation.warnings.length > 0) {
    log.debug('QA', `warnings: ${validation.warnings.join('; ')}`);
  }

  return { result: current, passed, warnings: validation.warnings };
}

export interface FlowResponse {
  text: string;
  state: RecipeFlowState;
}

/**
 * Handle meal type selection (button tap).
 */
export function handleMealTypeSelected(
  state: RecipeFlowState,
  mealType: 'breakfast' | 'lunch' | 'dinner',
): FlowResponse {
  state.mealType = mealType;
  state.phase = 'awaiting_preferences';

  const targets = targetsForMealType(mealType);
  log.debug('FLOW', `meal type selected: ${mealType}, targets: ${targets.calories} cal, ${targets.protein}g P, ${targets.fat}g F, ${targets.carbs}g C`);

  return {
    text: `${capitalize(mealType)} recipe — targets: ${targets.calories} cal, ${targets.protein}g P, ${targets.fat}g F, ${targets.carbs}g C.\n\nDescribe what you want (cuisine, ingredients, style) or just say "surprise me."`,
    state,
  };
}

/**
 * Handle user preferences input and generate a recipe.
 */
export async function handlePreferencesAndGenerate(
  state: RecipeFlowState,
  preferences: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  state.preferences = preferences;
  const targets = targetsForMealType(state.mealType!);

  log.debug('FLOW', `generating ${state.mealType} recipe, preferences: "${preferences}"`);

  const genResult = await generateRecipe({
    mealType: state.mealType!,
    targets,
    preferences,
  }, llm);

  log.debug('FLOW', `recipe generated: "${genResult.recipe.name}" — ${genResult.recipe.perServing.calories} cal, ${genResult.recipe.perServing.protein}g P`);

  // Validate macros and correct if needed
  const { result: corrected, passed, warnings } = await validateAndCorrect(genResult, targets, llm);

  const rendered = renderRecipe(corrected.recipe);
  let text = rendered;
  if (!passed) {
    text += `\n\n⚠️ Macros are slightly off target after correction — review the numbers above.`;
  }
  if (warnings.length > 0) {
    text += `\n\n⚠️ ${warnings.join('\n⚠️ ')}`;
  }

  state.currentRecipe = corrected.recipe;
  state.conversationHistory = corrected.messages;
  state.phase = 'reviewing';
  log.debug('FLOW', 'phase → reviewing');

  return { text, state };
}

/**
 * Handle refinement request — regenerate with feedback.
 */
export async function handleRefinement(
  state: RecipeFlowState,
  feedback: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  log.debug('FLOW', `refining recipe, feedback: "${feedback}"`);
  const targets = targetsForMealType(state.mealType!);

  const refineResult = await refineRecipe(
    state.conversationHistory!,
    feedback,
    llm,
  );

  log.debug('FLOW', `refined recipe: "${refineResult.recipe.name}" — ${refineResult.recipe.perServing.calories} cal, ${refineResult.recipe.perServing.protein}g P`);

  // Validate macros and correct if needed
  const { result: corrected, passed, warnings } = await validateAndCorrect(refineResult, targets, llm);

  const rendered = renderRecipe(corrected.recipe);
  let text = rendered;
  if (!passed) {
    text += `\n\n⚠️ Macros are slightly off target after correction — review the numbers above.`;
  }
  if (warnings.length > 0) {
    text += `\n\n⚠️ ${warnings.join('\n⚠️ ')}`;
  }

  state.currentRecipe = corrected.recipe;
  state.conversationHistory = corrected.messages;
  state.phase = 'reviewing';

  return { text, state };
}

/**
 * Save the current recipe to the database.
 */
export async function handleSave(
  state: RecipeFlowState,
  db: RecipeDatabase,
): Promise<FlowResponse> {
  if (!state.currentRecipe) {
    return { text: 'No recipe to save.', state };
  }

  await db.save(state.currentRecipe);
  const name = state.currentRecipe.name;
  log.info('DB', `Recipe saved: "${name}" (${state.currentRecipe.slug})`);

  return {
    text: `Saved "${name}" to your recipe database.`,
    state: createRecipeFlowState(), // reset
  };
}

/**
 * Classify whether a message sent during recipe review is a question or a refinement request.
 * Uses GPT-5.4-nano for near-instant classification.
 *
 * Questions: "what's rigatoni?", "is this spicy?", "how long does this keep?"
 * Refinements: "swap rigatoni for penne", "less fat", "make it vegetarian"
 */
export async function classifyReviewIntent(
  text: string,
  llm: LLMProvider,
): Promise<ReviewIntent> {
  const result = await llm.complete({
    model: 'nano',
    json: true,
    context: 'intent-classification',
    messages: [
      {
        role: 'system',
        content: `Classify the user's message about a recipe into exactly one intent:
- "question": asking about an ingredient, technique, nutrition, storage, or anything else. They want information, not a change.
- "refinement": requesting a change to the recipe (swap ingredient, adjust macros, different cuisine, etc.)

Respond with JSON: {"intent": "question"} or {"intent": "refinement"}`,
      },
      { role: 'user', content: text },
    ],
    maxTokens: 20,
  });

  try {
    const parsed = JSON.parse(result.content);
    return parsed.intent === 'question' ? 'question' : 'refinement';
  } catch {
    return 'refinement'; // safe default — refinement at least does something
  }
}

/**
 * Answer a question about the current recipe without modifying it.
 * Uses GPT-5.4-mini for fast, concise answers. State stays in 'reviewing'.
 */
export async function handleRecipeQuestion(
  state: RecipeFlowState,
  question: string,
  llm: LLMProvider,
): Promise<FlowResponse> {
  const recipe = state.currentRecipe!;

  log.debug('FLOW', `answering question: "${question}" (recipe: ${recipe.name})`);

  const ingredientList = recipe.ingredients
    .map((i) => `${i.name}: ${i.amount}${i.unit} (${i.role})`)
    .join('\n');

  const result = await llm.complete({
    model: 'mini',
    reasoning: 'low',
    context: 'recipe-question',
    messages: [
      {
        role: 'system',
        content: `You are a helpful cooking assistant. The user is reviewing a recipe and has a question. Answer concisely (1-3 sentences). If relevant, relate your answer to their recipe.

Recipe: ${recipe.name}
Cuisine: ${recipe.cuisine}
Ingredients:\n${ingredientList}
Per serving: ${recipe.perServing.calories} cal, ${recipe.perServing.protein}g P, ${recipe.perServing.fat}g F, ${recipe.perServing.carbs}g C`,
      },
      { role: 'user', content: question },
    ],
    maxTokens: 300,
  });

  // State unchanged — still reviewing the same recipe
  return { text: result.content, state };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
