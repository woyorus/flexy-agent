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

import type { ShoppingList, Recipe, Measurement, BatchView, FlexSlot, MealEvent, PlanSession } from '../models/types.js';
import type { SolverOutput, DailyBreakdown } from '../solver/types.js';
import { esc } from '../utils/telegram-markdown.js';
import { getBatchForMeal, isReheat, getServingNumber, getDayRange } from '../plan/helpers.js';

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
 * Format the shopping list for display in Telegram (MarkdownV2).
 *
 * @param list - The three-tier shopping list
 * @param targetDate - ISO date for the cook day
 * @param scopeDescription - e.g., "Salmon Pasta (3 servings) + Breakfast"
 */
export function formatShoppingList(list: ShoppingList, targetDate: string, scopeDescription: string): string {
  const dayLabel = formatDayMdV2Long(targetDate);
  const lines: string[] = [];

  lines.push(`*What you'll need* — ${esc(dayLabel)}`);
  lines.push(`_For: ${esc(scopeDescription)}_`);
  lines.push('');

  // Tier 3 — main buy list by category
  for (const cat of list.categories) {
    lines.push(`*${esc(cat.name)}*`);
    for (const item of cat.items) {
      let line = `\\- ${esc(capitalizeFirst(item.name))} — ${esc(String(item.amount))}${esc(item.unit)}`;
      if (item.note) {
        line += ` _${esc(item.note)}_`;
      }
      lines.push(line);
    }
    lines.push('');
  }

  // Tier 2 — "check you have"
  if (list.checkYouHave.length > 0) {
    lines.push(`_Check you have:_`);
    lines.push(`_${esc(list.checkYouHave.join(', '))}_`);
    lines.push('');
  }

  // Custom items (future)
  if (list.customItems.length > 0) {
    lines.push(`*OTHER*`);
    for (const item of list.customItems) {
      lines.push(`\\- ${esc(item)}`);
    }
    lines.push('');
  }

  lines.push(`_Long\\-press to copy\\. Paste into Notes,_`);
  lines.push(`_then remove what you already have\\._`);

  return lines.join('\n');
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

// ─── Plan view formatters (MarkdownV2) ─────────────────────────────────────

/**
 * Format the "next action" view: today + next 2 days (3 days total).
 *
 * Shows lunch and dinner for each day. Meals can be cook batches, reheats,
 * flex slots, or events. Uses MarkdownV2 formatting.
 *
 * @param batchViews - Batch+Recipe view models for all planned batches
 * @param events - Meal events (restaurant outings, etc.)
 * @param flexSlots - Flex slots (user-decided meals)
 * @param today - ISO date string for "today"
 * @returns MarkdownV2 formatted string
 */
export function formatNextAction(
  batchViews: BatchView[],
  events: MealEvent[],
  flexSlots: FlexSlot[],
  today: string,
): string {
  const batches = batchViews.map(bv => bv.batch);
  const dates = getNextNDates(today, 3);
  const lines: string[] = [];

  for (const date of dates) {
    const dayLabel = formatDayMdV2Short(date);
    lines.push(`*${esc(dayLabel)}*`);

    for (const mealType of ['lunch', 'dinner'] as const) {
      const event = events.find(e => e.day === date && e.mealTime === mealType);
      if (event) {
        lines.push(`🍽️ ${esc(event.name)}`);
        continue;
      }

      const flex = flexSlots.find(f => f.day === date && f.mealTime === mealType);
      if (flex) {
        lines.push(`Flex`);
        continue;
      }

      const match = getBatchForMeal(batches, date, mealType);
      if (match) {
        const recipeName = batchViews.find(bv => bv.batch.id === match.batch.id)?.recipe.name ?? 'Recipe';
        if (match.isReheat) {
          lines.push(`${esc(recipeName)} _\\(reheat\\)_`);
        } else {
          const mealLabel = capitalizeFirst(mealType);
          lines.push(`🔪 Cook ${mealLabel}: *${esc(recipeName)}* — ${match.batch.servings} servings`);
        }
        continue;
      }

      lines.push(`—`);
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/**
 * Format the full week overview for a confirmed plan.
 *
 * Header with date range, breakfast note, one line per day with lunch/dinner,
 * cook-day indicators, weekly target footer, and prompt for day detail.
 * Uses MarkdownV2 formatting.
 *
 * @param session - The confirmed plan session (for horizon dates and breakfast)
 * @param batchViews - Batch+Recipe view models
 * @param events - Meal events
 * @param flexSlots - Flex slots
 * @param breakfastRecipe - The breakfast recipe (if any)
 * @returns MarkdownV2 formatted string
 */
export function formatWeekOverview(
  session: PlanSession,
  batchViews: BatchView[],
  events: MealEvent[],
  flexSlots: FlexSlot[],
  breakfastRecipe: Recipe | undefined,
): string {
  const batches = batchViews.map(bv => bv.batch);
  const dates = buildDateRange(session.horizonStart, session.horizonEnd);

  const startLabel = formatDayMdV2Short(session.horizonStart);
  const endLabel = formatDayMdV2Short(session.horizonEnd);

  const lines: string[] = [];
  lines.push(`*Your week: ${esc(startLabel)} – ${esc(endLabel)}*`);
  lines.push(`Breakfast: ${esc(breakfastRecipe?.name ?? 'Breakfast')} \\(daily\\)`);
  lines.push('');

  for (const date of dates) {
    const shortDay = formatWeekdayShort(date);
    let line = `*${esc(shortDay)}*`;

    // Check if any batch cooks on this day
    const cookOnDay = batches.some(b => b.eatingDays.length > 0 && b.eatingDays[0] === date);
    if (cookOnDay) {
      line += ` 🔪`;
    }

    const lunchName = getMealSlotName(batches, batchViews, events, flexSlots, date, 'lunch');
    const dinnerName = getMealSlotName(batches, batchViews, events, flexSlots, date, 'dinner');
    line += ` L: ${lunchName} · D: ${dinnerName}`;

    lines.push(line);
  }

  lines.push('');
  lines.push(`*Weekly target: on track ✓*`);
  lines.push(`_Tap a day for details:_`);

  return lines.join('\n');
}

/**
 * Format detailed view of a single day (lunch + dinner).
 *
 * Shows cook instructions, reheat info with serving numbers, flex slots,
 * or events for each meal. Uses MarkdownV2 formatting.
 *
 * @param date - ISO date string for the day to detail
 * @param batchViews - Batch+Recipe view models
 * @param events - Meal events
 * @param flexSlots - Flex slots
 * @returns MarkdownV2 formatted string
 */
export function formatDayDetail(
  date: string,
  batchViews: BatchView[],
  events: MealEvent[],
  flexSlots: FlexSlot[],
): string {
  const batches = batchViews.map(bv => bv.batch);
  const dayLabel = formatDayMdV2Long(date);

  const lines: string[] = [];
  lines.push(`*${esc(dayLabel)}*`);
  lines.push('');

  for (const mealType of ['lunch', 'dinner'] as const) {
    const mealLabel = capitalizeFirst(mealType);

    const event = events.find(e => e.day === date && e.mealTime === mealType);
    if (event) {
      lines.push(`🍽️ ${esc(mealLabel)}: ${esc(event.name)}`);
      continue;
    }

    const flex = flexSlots.find(f => f.day === date && f.mealTime === mealType);
    if (flex) {
      lines.push(`${esc(mealLabel)}: *Flex*`);
      continue;
    }

    const match = getBatchForMeal(batches, date, mealType);
    if (match) {
      const recipeName = batchViews.find(bv => bv.batch.id === match.batch.id)?.recipe.name ?? 'Recipe';

      if (match.isReheat) {
        const cookDay = match.batch.eatingDays[0] ?? date;
        const cookDayLabel = formatWeekdayShort(cookDay);
        const servNum = getServingNumber(match.batch, date);
        const total = match.batch.servings;
        lines.push(`${esc(mealLabel)}: ${esc(recipeName)}`);
        lines.push(`_Reheat \\(cooked ${esc(cookDayLabel)}\\) · serving ${servNum} of ${total}_`);
      } else {
        const range = getDayRange(match.batch);
        const dayRangeStr = range
          ? `${formatWeekdayShort(range.first)}–${formatWeekdayShort(range.last)}`
          : '';
        const cal = match.batch.actualPerServing.calories;
        lines.push(`🔪 ${esc(mealLabel)}: *${esc(recipeName)}*`);
        lines.push(`Cook ${match.batch.servings} servings \\(${esc(dayRangeStr)}\\) · \\~${cal} cal each`);
      }
      continue;
    }

    lines.push(`${esc(mealLabel)}: —`);
  }

  return lines.join('\n');
}

/**
 * Format the post-confirmation message after a plan is locked.
 *
 * Shows confirmation, first cook day with batch list, and shopping reminder.
 * Uses MarkdownV2 formatting.
 *
 * @param horizonStart - ISO date for plan start
 * @param horizonEnd - ISO date for plan end
 * @param firstCookDay - ISO date of the first cook day
 * @param cookBatchViews - BatchViews cooking on the first cook day
 * @returns MarkdownV2 formatted string
 */
export function formatPostConfirmation(
  horizonStart: string,
  horizonEnd: string,
  firstCookDay: string,
  cookBatchViews: BatchView[],
): string {
  const startLabel = formatDayMdV2Short(horizonStart);
  const endLabel = formatDayMdV2Short(horizonEnd);
  const firstCookDayLabel = formatDayMdV2Long(firstCookDay);

  const lines: string[] = [];
  lines.push(`Plan locked for ${esc(startLabel)} – ${esc(endLabel)} ✓`);
  lines.push('');
  lines.push(`Your first cook day is ${esc(firstCookDayLabel)}:`);

  for (const bv of cookBatchViews) {
    lines.push(`  🔪 ${esc(bv.recipe.name)} — ${bv.batch.servings} servings`);
  }

  lines.push('');
  lines.push(`You'll need to shop for both \\+ breakfast\\.`);

  return lines.join('\n');
}

// ─── Plan view helpers (MarkdownV2) ────────────────────────────────────────

/**
 * Get N consecutive ISO date strings starting from `start`.
 */
function getNextNDates(start: string, n: number): string[] {
  const dates: string[] = [];
  const d = new Date(start + 'T00:00:00');
  for (let i = 0; i < n; i++) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Build an array of ISO date strings from startDate to endDate (inclusive).
 */
function buildDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const d = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (d <= end) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Format a date as "Wed, Apr 8" style for MarkdownV2 display.
 */
function formatDayMdV2Short(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Format a date as "Thursday, Apr 10" style for MarkdownV2 display.
 */
function formatDayMdV2Long(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/**
 * Format a date as short weekday only (e.g. "Mon", "Tue").
 */
function formatWeekdayShort(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

/**
 * Get the display name for a meal slot in the week overview.
 *
 * Returns the recipe name (with 🔪 prefix for cook days), "Flex" for flex slots,
 * the event name for events, or "—" if nothing is scheduled.
 */
function getMealSlotName(
  batches: import('../models/types.js').Batch[],
  batchViews: BatchView[],
  events: MealEvent[],
  flexSlots: FlexSlot[],
  date: string,
  mealType: 'lunch' | 'dinner',
): string {
  const event = events.find(e => e.day === date && e.mealTime === mealType);
  if (event) return esc(event.name);

  const flex = flexSlots.find(f => f.day === date && f.mealTime === mealType);
  if (flex) return 'Flex';

  const match = getBatchForMeal(batches, date, mealType);
  if (match) {
    const recipeName = batchViews.find(bv => bv.batch.id === match.batch.id)?.recipe.name ?? 'Recipe';
    const isCookDay = match.batch.eatingDays.length > 0 && match.batch.eatingDays[0] === date;
    if (isCookDay) {
      return `🔪 ${esc(recipeName)}`;
    }
    return esc(recipeName);
  }

  return '—';
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
