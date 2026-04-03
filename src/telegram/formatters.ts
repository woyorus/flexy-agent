/**
 * Message formatters for Telegram output.
 *
 * Converts internal data structures into user-friendly Telegram messages.
 * Uses Telegram's MarkdownV2 formatting where beneficial.
 *
 * These formatters are pure functions: data in, string out. They don't send
 * messages — that's the bot handler's job.
 */

import type { WeeklyPlan, ShoppingList, Recipe } from '../models/types.js';
import type { SolverOutput, DailyBreakdown } from '../solver/types.js';

/**
 * Format the budget review message shown in Step 5 of planning.
 * Displays weekly totals, daily breakdown, and macro summary.
 */
export function formatBudgetReview(output: SolverOutput, targets: { calories: number; protein: number }): string {
  const { weeklyTotals, dailyBreakdown } = output;

  let msg = `Here's your week:\n\n`;
  msg += `Weekly budget: ${targets.calories.toLocaleString()} cal | ${targets.protein}g protein\n`;
  msg += `Planned meals: ${(weeklyTotals.calories - weeklyTotals.funFoodCalories).toLocaleString()} cal (${((weeklyTotals.calories - weeklyTotals.funFoodCalories) / targets.calories * 100).toFixed(1)}%)\n`;
  msg += `Fun food: ${weeklyTotals.funFoodCalories.toLocaleString()} cal (${weeklyTotals.funFoodPercent}%)\n`;

  const eventCal = dailyBreakdown.reduce(
    (sum, d) => sum + d.events.reduce((s, e) => s + e.estimatedCalories, 0), 0);
  if (eventCal > 0) {
    msg += `Restaurant: ${eventCal.toLocaleString()} cal (${(eventCal / targets.calories * 100).toFixed(1)}%)\n`;
  }

  msg += `\nProtein: ${weeklyTotals.protein}g planned (target: ${targets.protein}g) ${weeklyTotals.protein >= targets.protein ? '✓' : '⚠️'}\n\n`;

  // Daily breakdown
  for (const day of dailyBreakdown) {
    const dayName = formatDayShort(day.day);
    const parts: string[] = [
      `Bfast ${day.breakfast.calories}`,
      `Lunch ${day.lunch.calories}`,
      `Dinner ${day.dinner.calories}`,
    ];

    const funFoodStr = day.funFoods.map((f) => f.name).join(', ');
    const eventStr = day.events.map((e) => e.name).join(', ');

    let line = `${dayName}  ${day.totalCalories.toLocaleString()} cal  ${day.totalProtein}g P | ${parts.join(' | ')}`;
    if (funFoodStr) line += ` | ${funFoodStr}`;
    if (eventStr) line += ` | 🍽️ ${eventStr}`;
    msg += line + '\n';
  }

  if (output.warnings.length > 0) {
    msg += `\n⚠️ ${output.warnings.join('\n⚠️ ')}`;
  } else {
    msg += `\nAll batches sized. Calories and protein on target.`;
  }

  return msg;
}

/**
 * Format the shopping list for display in Telegram.
 */
export function formatShoppingList(list: ShoppingList): string {
  let msg = `Shopping list for this week:\n`;

  for (const cat of list.categories) {
    msg += `\n${cat.name}\n`;
    for (const item of cat.items) {
      msg += `- ${capitalizeFirst(item.name)}: ${item.amount}${item.unit}\n`;
    }
  }

  if (list.customItems.length > 0) {
    msg += `\nOTHER\n`;
    for (const item of list.customItems) {
      msg += `- ${item}\n`;
    }
  }

  return msg;
}

/**
 * Format a recipe for display in Telegram.
 */
export function formatRecipe(recipe: Recipe): string {
  let msg = `${recipe.name}\n`;
  msg += `${recipe.perServing.calories} cal | ${recipe.perServing.protein}g protein | ${recipe.perServing.fat}g fat | ${recipe.perServing.carbs}g carbs\n`;
  msg += `Cuisine: ${recipe.cuisine} | Prep: ${recipe.prepTimeMinutes} min\n`;
  msg += `Tags: ${recipe.tags.join(', ')}\n\n`;

  msg += `Ingredients (per serving):\n`;
  for (const ing of recipe.ingredients) {
    msg += `- ${ing.name}: ${ing.amount}${ing.unit}\n`;
  }

  msg += `\n${recipe.steps}\n`;

  if (recipe.notes) {
    msg += `\nNotes:\n${recipe.notes}\n`;
  }

  msg += `\nStorage: ${recipe.storage.fridgeDays} days fridge`;
  if (recipe.storage.freezable) msg += `, freezable`;
  msg += `\nReheat: ${recipe.storage.reheat}`;

  return msg;
}

/**
 * Format a recipe list for browsing.
 */
export function formatRecipeList(recipes: Recipe[]): string {
  const lunches = recipes.filter((r) => r.mealTypes.includes('lunch') || r.mealTypes.includes('dinner'));
  const breakfasts = recipes.filter((r) => r.mealTypes.includes('breakfast'));

  let msg = `Your recipes (${recipes.length} total):\n`;

  if (lunches.length > 0) {
    msg += `\nLUNCH & DINNER\n`;
    for (const r of lunches) {
      msg += `- ${r.name}\n`;
    }
  }

  if (breakfasts.length > 0) {
    msg += `\nBREAKFAST\n`;
    for (const r of breakfasts) {
      msg += `- ${r.name}\n`;
    }
  }

  return msg;
}

/**
 * Format cooking schedule for display.
 */
export function formatCookingSchedule(
  output: SolverOutput,
  recipeSlugs: Map<string, string>,
): string {
  let msg = `Cooking schedule:\n\n`;
  for (const cookDay of output.cookingSchedule) {
    msg += `${formatDay(cookDay.day)}:\n`;
    for (const batchId of cookDay.batchIds) {
      const batch = output.batchTargets.find((b) => b.id === batchId);
      if (batch) {
        const name = recipeSlugs.get(batch.recipeSlug ?? '') ?? 'New recipe';
        msg += `  Cook ${batch.mealType} for ${batch.days.map(formatDayShort).join('-')}: ${name} (${batch.servings} servings)\n`;
      }
    }
  }
  return msg;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDayShort(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatDay(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
