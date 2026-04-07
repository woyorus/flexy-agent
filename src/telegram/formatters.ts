/**
 * Message formatters for Telegram output.
 *
 * Converts internal data structures into user-friendly Telegram messages.
 * Plain text output (no parse_mode). The weekly report formatter uses
 * legacy Markdown mode (single asterisk bold) — see formatWeeklyReport.
 *
 * These formatters are pure functions: data in, string out. They don't send
 * messages — that's the bot handler's job.
 */

import type { ShoppingList, Recipe, Measurement } from '../models/types.js';
import type { SolverOutput, DailyBreakdown } from '../solver/types.js';

/**
 * Format the budget review message shown in Step 5 of planning.
 * Displays weekly totals, daily breakdown, and macro summary.
 */
export function formatBudgetReview(output: SolverOutput, targets: { calories: number; protein: number }): string {
  const { weeklyTotals, dailyBreakdown } = output;

  const mealCal = weeklyTotals.calories - weeklyTotals.treatBudget - weeklyTotals.flexSlotCalories;
  let msg = `Here's your week:\n\n`;
  msg += `Weekly budget: ${targets.calories.toLocaleString()} cal | ${targets.protein}g protein\n`;
  msg += `Planned meals: ${mealCal.toLocaleString()} cal (${(mealCal / targets.calories * 100).toFixed(1)}%)\n`;
  if (weeklyTotals.flexSlotCalories > 0) {
    msg += `Flex meals: ${weeklyTotals.flexSlotCalories.toLocaleString()} cal\n`;
  }
  if (weeklyTotals.treatBudget > 0) {
    const occasions = Math.round(weeklyTotals.treatBudget / 350);
    msg += `Treats: ${occasions >= 2 ? `${occasions} × ~${Math.round(weeklyTotals.treatBudget / occasions)}` : `~${weeklyTotals.treatBudget}`} cal (spend whenever)\n`;
  }

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
      `Lunch ${day.lunch.calories}${day.lunch.flexBonus ? ' flex' : ''}`,
      `Dinner ${day.dinner.calories}${day.dinner.flexBonus ? ' flex' : ''}`,
    ];

    const eventStr = day.events.map((e) => e.name).join(', ');

    let line = `${dayName}  ${day.totalCalories.toLocaleString()} cal  ${day.totalProtein}g P | ${parts.join(' | ')}`;
    if (eventStr) line += ` | 🍽️ ${eventStr}`;
    msg += line + '\n';
  }

  if (output.warnings.length > 0) {
    msg += `\n⚠️ ${output.warnings.join('\n⚠️ ')}`;
  } else {
    msg += `\nCalories and protein on target.`;
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
  msg += `${recipe.perServing.calories} cal | ${recipe.perServing.protein}g P | ${recipe.perServing.fat}g F | ${recipe.perServing.carbs}g C\n`;
  msg += `Cuisine: ${recipe.cuisine} | Prep: ${recipe.prepTimeMinutes} min\n`;
  msg += `Tags: ${recipe.tags.join(', ')}\n\n`;

  msg += `Ingredients (per serving):\n`;
  for (const ing of recipe.ingredients) {
    msg += `- ${ing.name}: ${ing.amount}${ing.unit}\n`;
  }

  msg += `\n${recipe.body}\n`;

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

// ─── Progress formatters ────────────────────────────────────────────────────

/**
 * Format measurement logging confirmation.
 */
export function formatMeasurementConfirmation(weight: number, waist: number | null): string {
  if (waist != null) {
    return `Logged ✓ ${weight} kg / ${waist} cm`;
  }
  return `Logged ✓ ${weight} kg`;
}

// Note: this formatter uses legacy Markdown mode (parse_mode: 'Markdown'), not MarkdownV2.
// Bold is *text* (single asterisk), italic is _text_.

/**
 * Format a weekly progress report.
 *
 * @param currentWeek - Measurements for the completed week being reported
 * @param previousWeek - Measurements for the week before (for delta computation)
 * @param weekStart - ISO date of the reported week's Monday
 * @param weekEnd - ISO date of the reported week's Sunday
 */
export function formatWeeklyReport(
  currentWeek: Measurement[],
  previousWeek: Measurement[],
  weekStart: string,
  weekEnd: string,
): string {
  const startLabel = formatWeeklyDate(weekStart);
  const endLabel = formatWeeklyDate(weekEnd);

  const currentAvgWeight = avg(currentWeek.map((m) => m.weightKg));
  const currentWaists = currentWeek.filter((m) => m.waistCm != null).map((m) => m.waistCm!);
  const currentAvgWaist = currentWaists.length > 0 ? avg(currentWaists) : null;

  let msg = `*Week of ${startLabel} – ${endLabel}*\n\n`;

  if (previousWeek.length === 0) {
    // First week — no delta
    msg += `Weight: *${round1(currentAvgWeight)} kg* avg`;
    if (currentAvgWaist != null) {
      msg += `\nWaist: *${round1(currentAvgWaist)} cm* avg`;
    }
    msg += `\n\n_Next report ready Sunday._\n_(delta shown once you have two weeks of data)_`;
    return msg;
  }

  const previousAvgWeight = avg(previousWeek.map((m) => m.weightKg));
  const previousWaists = previousWeek.filter((m) => m.waistCm != null).map((m) => m.waistCm!);
  const previousAvgWaist = previousWaists.length > 0 ? avg(previousWaists) : null;

  const weightDelta = currentAvgWeight - previousAvgWeight;
  const weightArrow = weightDelta <= 0 ? '↓' : '↑';
  msg += `Weight: *${round1(currentAvgWeight)} kg* avg (${weightArrow}${round1(Math.abs(weightDelta))} from last week)`;

  if (currentAvgWaist != null && previousAvgWaist != null) {
    const waistDelta = currentAvgWaist - previousAvgWaist;
    const waistArrow = waistDelta <= 0 ? '↓' : '↑';
    msg += `\nWaist: *${round1(currentAvgWaist)} cm* avg (${waistArrow}${round1(Math.abs(waistDelta))} from last week)`;
  } else if (currentAvgWaist != null) {
    msg += `\nWaist: *${round1(currentAvgWaist)} cm* avg`;
  }

  const tone = pickWeeklyReportTone(currentAvgWeight, previousAvgWeight, currentAvgWaist, previousAvgWaist);
  msg += `\n\n${tone}`;
  msg += `\n\n_Next report ready Sunday._`;
  return msg;
}

/**
 * Choose a motivational tone message based on weight/waist delta.
 *
 * Only called when previous week data exists.
 */
export function pickWeeklyReportTone(
  currentAvgWeight: number,
  previousAvgWeight: number,
  currentAvgWaist: number | null,
  previousAvgWaist: number | null,
): string {
  const delta = currentAvgWeight - previousAvgWeight;

  // Loss > 0.5 kg
  if (delta < -0.5) {
    return 'Great progress. If this pace holds, we might ease up slightly -- sustainability matters more than speed.';
  }

  // Loss 0.1–0.5 kg (delta ≤ −0.1)
  if (delta <= -0.1) {
    return 'Steady and sustainable. 0.2-0.5 kg/week is a healthy, sustainable pace.';
  }

  // Plateau (−0.1 < delta < 0.3)
  if (delta < 0.3) {
    if (currentAvgWaist != null && previousAvgWaist != null) {
      const waistDelta = currentAvgWaist - previousAvgWaist;
      if (waistDelta < 0) {
        return `Weight is stable but your waist is down ${round1(Math.abs(waistDelta))} cm -- you're recomposing, the scale will catch up.`;
      }
    }
    return "Weight is stable -- normal. Fluctuations mask fat loss. Keep going.";
  }

  // Up 0.3+ kg
  return "Week-to-week fluctuations happen -- water, food volume, stress. One week doesn't define the trend. Keep going.";
}

function avg(nums: number[]): number {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function round1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function formatWeeklyDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
