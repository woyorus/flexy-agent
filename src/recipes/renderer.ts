/**
 * Recipe renderer.
 *
 * Combines structured YAML data (ingredients with amounts, macros) with the free-form
 * recipe body text to produce a complete, human-readable recipe for display in Telegram.
 *
 * Supports dynamic rendering with scaled amounts — the same recipe body text can be
 * rendered with different ingredient quantities depending on the solver's calorie target.
 *
 * The render flow:
 * 1. Header: recipe name + macros per serving (all four)
 * 2. Ingredients: grouped by component (main, carb side, side), with exact amounts
 * 3. Body: the free-form recipe text with `{ingredient_name}` placeholders resolved
 *    to formatted amounts (e.g., `{olive oil}` → `15ml olive oil`)
 */

import type { Recipe, RecipeIngredient, Batch, ScaledIngredient } from '../models/types.js';
import { esc, escapeRecipeBody } from '../utils/telegram-markdown.js';

/**
 * Render a recipe for Telegram display.
 *
 * @param recipe - The recipe to render
 * @param scaledIngredients - Optional scaled ingredients (from solver). If not provided, uses recipe's base amounts.
 * @param servings - Number of servings to show batch amounts for (optional — omit for per-serving display)
 * @returns Formatted string for Telegram
 */
export function renderRecipe(
  recipe: Recipe,
  scaledIngredients?: RecipeIngredient[],
  servings?: number,
): string {
  const ingredients = scaledIngredients ?? recipe.ingredients;
  const parts: string[] = [];

  // Header — MarkdownV2 formatted
  parts.push(`*${esc(recipe.name)}*`);
  parts.push(`_${esc(String(recipe.perServing.calories))} cal \\| ${esc(String(recipe.perServing.protein))}g P \\| ${esc(String(recipe.perServing.fat))}g F \\| ${esc(String(recipe.perServing.carbs))}g C_`);
  parts.push(`${esc(recipe.cuisine)} · ${recipe.prepTimeMinutes} min · ${esc(recipe.tags.join(', '))}`);
  parts.push('');

  // Ingredients grouped by component
  const title = servings ? `*Ingredients \\(${servings} servings\\)*` : `*Ingredients \\(per serving\\)*`;
  parts.push(title);

  const componentGroups = groupByComponent(ingredients, recipe.structure);
  for (const [componentName, ings] of componentGroups) {
    if (componentGroups.size > 1) {
      parts.push(`\n*${esc(componentName)}:*`);
    }
    for (const ing of ings) {
      const amount = servings ? ing.amount * servings : ing.amount;
      parts.push(`  ${esc(ing.name)}: ${esc(formatAmount(amount))}${esc(ing.unit)}`);
    }
  }

  parts.push('');

  // Body — resolve {ingredient_name} placeholders with amounts from the ingredient list
  const body = resolvePlaceholders(recipe.body, ingredients, servings);
  parts.push(escapeRecipeBody(body));

  return parts.join('\n');
}

/**
 * Render a compact recipe summary for lists and planning views.
 */
export function renderRecipeSummary(recipe: Recipe): string {
  return `${recipe.name}\n${recipe.perServing.calories} cal | ${recipe.perServing.protein}g P | ${recipe.perServing.fat}g F | ${recipe.perServing.carbs}g C`;
}

/**
 * Group ingredients by their component, preserving structure order.
 */
function groupByComponent(
  ingredients: RecipeIngredient[],
  structure: Recipe['structure'],
): Map<string, RecipeIngredient[]> {
  const groups = new Map<string, RecipeIngredient[]>();

  // Initialize groups in structure order
  for (const comp of structure) {
    groups.set(comp.name, []);
  }

  for (const ing of ingredients) {
    const group = groups.get(ing.component);
    if (group) {
      group.push(ing);
    } else {
      // Fallback for unmatched components
      const fallback = groups.get('main') ?? [];
      fallback.push(ing);
      if (!groups.has('main')) groups.set('main', fallback);
    }
  }

  // Remove empty groups
  for (const [key, val] of groups) {
    if (val.length === 0) groups.delete(key);
  }

  return groups;
}

/**
 * Replace `{ingredient_name}` placeholders in body text with the ingredient's
 * formatted amount + unit. Match is case-insensitive. Unmatched placeholders
 * pass through unchanged (legacy recipes won't have matching ingredients for
 * every brace token, and that's fine — they don't use placeholders).
 */
function resolvePlaceholders(
  body: string,
  ingredients: RecipeIngredient[],
  servings?: number,
): string {
  const byName = new Map<string, RecipeIngredient>();
  for (const ing of ingredients) {
    byName.set(ing.name.toLowerCase(), ing);
  }
  return body.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const ing = byName.get(name.toLowerCase());
    if (!ing) return _match; // not a known ingredient — leave as-is
    const amount = servings ? ing.amount * servings : ing.amount;
    return `${formatAmount(amount)}${ing.unit} ${ing.name}`;
  });
}

/**
 * Render a recipe in cook-time mode — batch totals, portion guidance, storage.
 *
 * Uses `batch.scaledIngredients` for amounts (totalForBatch), resolves
 * `{ingredient_name}` placeholders with batch amounts. Seasoning grouping:
 * unitless or universal-basics seasonings are collapsed onto one line.
 *
 * @param recipe - The recipe to render
 * @param batch - The batch with scaledIngredients and serving count
 * @returns MarkdownV2 formatted string
 */
export function renderCookView(recipe: Recipe, batch: Batch): string {
  const parts: string[] = [];

  // Header
  parts.push(`*${esc(recipe.name)}* — ${batch.servings} servings`);
  parts.push(`_\\~${batch.actualPerServing.calories} cal/serving · ${batch.actualPerServing.protein}g protein_`);
  parts.push(`_Divide into ${batch.servings} equal portions_`);
  parts.push('');

  // Ingredients (total for batch)
  parts.push(`*Ingredients* \\(total for batch\\):`);

  const universalBasics = new Set(['salt', 'black pepper', 'pepper']);
  const groupedSeasonings: string[] = [];
  const regularIngredients: ScaledIngredient[] = [];

  for (const ing of batch.scaledIngredients) {
    const isGroupable = ing.role === 'seasoning' &&
      (!ing.unit || ing.unit === '' || universalBasics.has(ing.name.toLowerCase()));
    if (isGroupable) {
      groupedSeasonings.push(ing.name);
    } else {
      regularIngredients.push(ing);
    }
  }

  for (const ing of regularIngredients) {
    parts.push(`  · ${esc(ing.name)} — \`${formatAmount(ing.totalForBatch)}${esc(ing.unit)}\``);
  }
  if (groupedSeasonings.length > 0) {
    parts.push(`  · ${esc(groupedSeasonings.join(', '))}`);
  }

  parts.push('');

  // Body with batch-amount placeholder resolution
  const body = resolveBatchPlaceholders(recipe.body, batch.scaledIngredients);
  parts.push(escapeRecipeBody(body));

  // Storage instructions
  if (recipe.storage) {
    parts.push('');
    parts.push(`_Storage: Fridge ${recipe.storage.fridgeDays} days\\. ${esc(recipe.storage.reheat)}_`);
  }

  return parts.join('\n');
}

/**
 * Replace `{ingredient_name}` placeholders with batch-total amounts.
 * Similar to resolvePlaceholders but uses ScaledIngredient (batch totals).
 */
function resolveBatchPlaceholders(body: string, scaledIngredients: ScaledIngredient[]): string {
  const byName = new Map<string, ScaledIngredient>();
  for (const ing of scaledIngredients) {
    byName.set(ing.name.toLowerCase(), ing);
  }
  return body.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const ing = byName.get(name.toLowerCase());
    if (!ing) return _match;
    return `${formatAmount(ing.totalForBatch)}${ing.unit} ${ing.name}`;
  });
}

/** Format amounts to user-friendly values. */
function formatAmount(amount: number): string {
  if (amount >= 100) return String(Math.round(amount / 5) * 5);
  if (amount >= 10) return String(Math.round(amount));
  if (amount >= 1) return String(Math.round(amount * 10) / 10);
  return String(Math.round(amount * 10) / 10);
}
