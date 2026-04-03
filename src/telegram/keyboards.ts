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

import { Keyboard, InlineKeyboard } from 'grammy';

// ─── Reply keyboard (persistent main menu) ───────────────────────────────────

/**
 * The persistent reply keyboard shown at the bottom of the chat.
 * Four core actions as defined in spec Section 8.
 */
export const mainMenuKeyboard = new Keyboard()
  .text('📋 Plan Week').text('🛒 Shopping List')
  .row()
  .text('📖 My Recipes').text('📊 Weekly Budget')
  .resized()
  .persistent();

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
  recipes: { name: string; slug: string }[],
  page: number,
  pageSize: number = 5,
): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(recipes.length / pageSize));
  const start = page * pageSize;
  const pageRecipes = recipes.slice(start, start + pageSize);

  const kb = new InlineKeyboard();

  // One button per recipe, one per row
  for (const r of pageRecipes) {
    kb.text(r.name, `rv_${r.slug}`).row();
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
export const recipeViewKeyboard = new InlineKeyboard()
  .text('← Back to recipes', 'recipe_back')
  .text('Add new recipe', 'add_recipe');

/** Recipe review after generation — save, refine, or start over */
export const recipeReviewKeyboard = new InlineKeyboard()
  .text('Save', 'save_recipe')
  .text('Refine', 'refine_recipe')
  .row()
  .text('New recipe', 'new_recipe')
  .text('Discard', 'discard_recipe');

/** Meal type selection for new recipe */
export const mealTypeKeyboard = new InlineKeyboard()
  .text('Breakfast', 'meal_type_breakfast')
  .text('Lunch', 'meal_type_lunch')
  .text('Dinner', 'meal_type_dinner');
