/**
 * Telegram keyboard layouts.
 *
 * Defines the persistent reply keyboard (main menu) and inline keyboards
 * used within flows. Keyboards are the primary interaction pattern — users
 * mostly tap buttons rather than typing.
 *
 * The reply keyboard is always visible at the bottom of the chat.
 * Inline keyboards appear within messages for flow-specific choices.
 *
 * Button taps bypass the LLM entirely — they map directly to state machine
 * transitions via callback data strings.
 */

/**
 * Callback data prefix registry.
 *
 * Telegram limits callback data to 64 bytes. All inline keyboard callbacks
 * use short prefixes to maximize space for payload (slugs, IDs, indices).
 *
 * Existing:
 *   rv_  — recipe view (payload: slug)
 *   rd_  — recipe delete (payload: slug)
 *   re_  — recipe edit (payload: slug)
 *   rp_  — recipe page (payload: page number)
 *
 * New (v0.0.4):
 *   na_  — next action (payload: action type)
 *   wo_  — week overview (payload: varies)
 *   dd_  — day detail (payload: ISO date, e.g. dd_2026-04-06)
 *   cv_  — cook view (payload: batch ID)
 *   sl_  — shopping list (payload: varies)
 *   pg_  — progress (payload: varies)
 */

import { Keyboard, InlineKeyboard } from 'grammy';
import type { PlanLifecycle } from '../plan/helpers.js';
import type { BatchView } from '../models/types.js';

/**
 * Telegram limits callback data to 64 bytes. With a 3-char prefix (rv_, rd_, re_),
 * the slug can be at most 61 chars. Truncate longer slugs — prefix matching in
 * the handler resolves the full slug from the database.
 */
const MAX_SLUG_IN_CALLBACK = 61;
export function truncateSlug(slug: string): string {
  return slug.length > MAX_SLUG_IN_CALLBACK ? slug.slice(0, MAX_SLUG_IN_CALLBACK) : slug;
}

// ─── Reply keyboard (persistent main menu) ───────────────────────────────────

/**
 * Build the persistent reply keyboard for the main menu.
 *
 * The top-left label changes based on the user's plan lifecycle:
 * - `no_plan` → "Plan Week" (start a new plan)
 * - `planning` → "Resume Plan" (continue in-progress planning)
 * - `active_*` → "My Plan" (view the active plan)
 *
 * Bottom-right is always "Progress" (renamed from "Weekly Budget" in v0.0.4).
 */
export function buildMainMenuKeyboard(lifecycle: PlanLifecycle): Keyboard {
  const planLabel =
    lifecycle === 'planning' ? '📋 Resume Plan' :
    lifecycle === 'no_plan' ? '📋 Plan Week' :
    '📋 My Plan';

  return new Keyboard()
    .text(planLabel).text('🛒 Shopping List')
    .row()
    .text('📖 My Recipes').text('📊 Progress')
    .resized()
    .persistent();
}

// ─── Inline keyboards (flow-specific) ────────────────────────────────────────

/** Step 0: Breakfast confirmation */
export function breakfastKeyboard(recipeName: string) {
  return new InlineKeyboard()
    .text('Keep it', 'keep_breakfast')
    .text('Change this week', 'change_breakfast');
}

/** Step 1: Events */
export const noEventsKeyboard = new InlineKeyboard()
  .text('No events this week', 'no_events')
  .text('Add event', 'add_event');

export const moreEventsKeyboard = new InlineKeyboard()
  .text("No, that's all", 'events_done')
  .text('Add another', 'add_event');

/** Step 2: Fun foods */
export function funFoodKeyboard(hasLastWeek: boolean) {
  const kb = new InlineKeyboard();
  if (hasLastWeek) {
    kb.text('Same as last week', 'same_as_last_week');
  }
  kb.text('Something different', 'different_fun_foods');
  return kb;
}

export const funFoodConfirmKeyboard = new InlineKeyboard()
  .text('Looks good', 'fun_foods_done')
  .text('Add more', 'add_more_fun_foods');

export const skipFunFoodKeyboard = new InlineKeyboard()
  .text('Add something', 'different_fun_foods')
  .text('Skip this week', 'skip_fun_foods');

/** Step 3: Recipe selection */
export const recipesKeyboard = new InlineKeyboard()
  .text('Approve', 'approve_recipes')
  .text('Swap something', 'swap_recipe');

/** Step 4: Cooking schedule */
export const cookingScheduleKeyboard = new InlineKeyboard()
  .text('Approve', 'approve_schedule')
  .text("I'd rather cook differently", 'change_schedule');

/** Step 5: Budget review */
export const reviewKeyboard = new InlineKeyboard()
  .text('✅ Confirm plan', 'confirm_plan')
  .text('Adjust something', 'adjust_something');

/** After plan is locked */
export const planLockedKeyboard = new InlineKeyboard()
  .text('🛒 View shopping list', 'view_shopping_list')
  .text('📖 View recipes', 'view_recipes');

/** Shopping list actions */
export const shoppingListKeyboard = new InlineKeyboard()
  .text('Add items', 'add_shopping_items')
  .text('Share list', 'share_shopping_list');

/** Recipe browse — old static keyboard, replaced by recipeListKeyboard() */
export const recipeBrowseKeyboard = new InlineKeyboard()
  .text('View recipe', 'view_recipe')
  .text('Add new recipe', 'add_recipe');

/**
 * Build a paginated recipe list keyboard.
 *
 * Each recipe becomes a tappable inline button (callback data: `rv_{slug}`).
 * Shows up to `pageSize` recipes per page with prev/next navigation.
 *
 * @param recipes - All recipes (will be sliced to the current page)
 * @param page - Zero-based page index
 * @param pageSize - Recipes per page (default 5)
 * @returns InlineKeyboard with recipe buttons, nav row, and "Add new recipe"
 */
export function recipeListKeyboard(
  recipes: { name: string; slug: string; shortName?: string }[],
  page: number,
  pageSize: number = 5,
  cookingSoonBatchViews?: BatchView[],
): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(recipes.length / pageSize));
  const start = page * pageSize;
  const pageRecipes = recipes.slice(start, start + pageSize);

  const kb = new InlineKeyboard();

  // Cooking Soon section — each batch gets a 🔪 button with cv_ callback
  if (cookingSoonBatchViews && cookingSoonBatchViews.length > 0) {
    for (const bv of cookingSoonBatchViews) {
      const label = `🔪 ${bv.recipe.shortName ?? bv.recipe.name}`;
      kb.text(label, `cv_${bv.batch.id}`).row();
    }
  }

  // One button per recipe, one per row
  // Telegram limits callback data to 64 bytes. With 3-char prefix (rv_), max slug is 61 chars.
  for (const r of pageRecipes) {
    kb.text(r.name, `rv_${truncateSlug(r.slug)}`).row();
  }

  // Navigation row (only if more than one page)
  if (totalPages > 1) {
    if (page > 0) {
      kb.text('← Prev', `rp_${page - 1}`);
    }
    kb.text(`${page + 1}/${totalPages}`, 'rp_noop');
    if (page < totalPages - 1) {
      kb.text('Next →', `rp_${page + 1}`);
    }
    kb.row();
  }

  // Add new recipe button
  kb.text('Add new recipe', 'add_recipe');

  return kb;
}

/**
 * Keyboard shown after viewing a single recipe from the list.
 * Lets the user go back to the recipe list or add a new recipe.
 */
/**
 * Keyboard shown after viewing a single recipe.
 * Includes the recipe slug in the delete callback so we know which recipe to remove.
 */
export function recipeViewKeyboard(slug: string) {
  const s = truncateSlug(slug);
  return new InlineKeyboard()
    .text('← Back to recipes', 'recipe_back')
    .text('Edit', `re_${s}`)
    .text('Delete', `rd_${s}`);
}

/** Recipe review after generation — save, refine, or start over */
export const recipeReviewKeyboard = new InlineKeyboard()
  .text('Save', 'save_recipe')
  .text('Refine', 'refine_recipe')
  .row()
  .text('New recipe', 'new_recipe')
  .text('Discard', 'discard_recipe');

// ─── Progress keyboards ──────────────────────────────────────────────────────

/** Progress screen: disambiguation prompt — confirm which number is weight vs waist. */
export const progressDisambiguationKeyboard = new InlineKeyboard()
  .text('Yes', 'pg_disambig_yes')
  .text('No, swap them', 'pg_disambig_no');

/** Progress screen: show the last completed weekly report. */
export const progressReportKeyboard = new InlineKeyboard()
  .text('Last weekly report', 'pg_last_report');

// ─── Recipe keyboards ────────────────────────────────────────────────────────

/** Meal type selection for new recipe */
export const mealTypeKeyboard = new InlineKeyboard()
  .text('Breakfast', 'meal_type_breakfast')
  .text('Lunch', 'meal_type_lunch')
  .text('Dinner', 'meal_type_dinner');

// ─── Plan week flow keyboards ───────────────────────────────────────────────────

/** Replan confirmation (D27) — user already has a future plan */
export const planReplanKeyboard = new InlineKeyboard()
  .text('Replan it', 'plan_replan_confirm')
  .text('Keep current plan', 'plan_replan_cancel');

/** Step 1: Breakfast confirmation */
export const planBreakfastKeyboard = new InlineKeyboard()
  .text('Keep it', 'plan_keep_breakfast')
  .text('Change this week', 'plan_change_breakfast');

/** Step 1: Meals out question */
export const planEventsKeyboard = new InlineKeyboard()
  .text('No meals out', 'plan_no_events')
  .text('Add meal out', 'plan_add_event');

/** After adding an event, prompt for more */
export const planMoreEventsKeyboard = new InlineKeyboard()
  .text("That's all", 'plan_events_done')
  .text('Add another', 'plan_add_event');

/** Plan proposal review — Plan 025: "Swap something" removed, users type adjustments directly. */
export const planProposalKeyboard = new InlineKeyboard()
  .text('Looks good', 'plan_approve');

/** After plan is confirmed — legacy, kept for backward compatibility */
export const planConfirmedKeyboard = new InlineKeyboard()
  .text('🛒 Shopping list', 'view_shopping_list')
  .text('📖 View recipes', 'view_plan_recipes');

// ─── Plan view keyboards (Phase 3) ────────────────────────────────────────

/**
 * Next Action keyboard — shows cooking buttons + navigation.
 *
 * @param nextCookBatchViews - BatchViews for the next cook session
 * @param lifecycle - Current plan lifecycle for conditional buttons
 */
export function nextActionKeyboard(
  nextCookBatchViews: BatchView[],
  lifecycle: PlanLifecycle,
): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Cook buttons for upcoming batches
  for (const bv of nextCookBatchViews) {
    const label = bv.recipe.shortName ?? bv.recipe.name;
    kb.text(`🔪 ${label} — ${bv.batch.servings} servings`, `cv_${bv.batch.id}`).row();
  }

  if (nextCookBatchViews.length > 0) {
    kb.text('🛒 Get shopping list', 'sl_next');
    kb.text('📅 View full week', 'wo_show');
  } else {
    kb.text('📅 View full week', 'wo_show');
  }

  return kb;
}

/**
 * Week Overview keyboard — day buttons for Mon-Sun + Back.
 *
 * @param weekDays - Array of 7 ISO date strings
 */
export function weekOverviewKeyboard(weekDays: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Derive day labels from actual dates (horizons can start on any day)
  const dayLabels = weekDays.map(d => {
    const date = new Date(d + 'T00:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  });

  // Row 1: first 4 days
  for (let i = 0; i < 4 && i < weekDays.length; i++) {
    kb.text(dayLabels[i]!, `dd_${weekDays[i]}`);
  }
  kb.row();

  // Row 2: remaining days
  for (let i = 4; i < 7 && i < weekDays.length; i++) {
    kb.text(dayLabels[i]!, `dd_${weekDays[i]}`);
  }
  kb.row();

  kb.text('← Back', 'na_show');

  return kb;
}

/**
 * Day Detail keyboard — cook buttons + shopping + back to week.
 *
 * @param date - ISO date for this day
 * @param cookBatchViews - BatchViews for batches cooking on this day
 * @param today - Today's ISO date (shopping button only for future/current days)
 */
export function dayDetailKeyboard(
  date: string,
  cookBatchViews: BatchView[],
  today: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const bv of cookBatchViews) {
    const label = bv.recipe.shortName ?? bv.recipe.name;
    kb.text(`🔪 ${label} — ${bv.batch.servings} servings`, `cv_${bv.batch.id}`).row();
  }

  if (date >= today && cookBatchViews.length > 0) {
    kb.text('🛒 Get shopping list', `sl_${date}`);
  }
  kb.text('← Back to week', 'wo_show');

  return kb;
}

/**
 * Post-confirmation keyboard (replaces planConfirmedKeyboard).
 */
export function postConfirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🛒 Get shopping list', 'sl_next')
    .text('📅 View full week', 'wo_show');
}

// ─── Cook view keyboards (Phase 4) ─────────────────────────────────────────

/**
 * Cook view keyboard — back to plan + recipe actions.
 */
export function cookViewKeyboard(recipeSlug: string): InlineKeyboard {
  const s = truncateSlug(recipeSlug);
  return new InlineKeyboard()
    .text('← Back to plan', 'na_show')
    .row()
    .text('Edit this recipe', `re_${s}`)
    .text('View in my recipes', `rv_${s}`);
}

// ─── Shopping list keyboard (Phase 5) ──────────────────────────────────────

/**
 * Shopping list keyboard — back to plan.
 * Replaces the old `shoppingListKeyboard` const.
 */
export function buildShoppingListKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('← Back to plan', 'na_show');
}
