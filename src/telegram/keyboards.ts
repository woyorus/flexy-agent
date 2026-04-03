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

/** Recipe browse */
export const recipeBrowseKeyboard = new InlineKeyboard()
  .text('View recipe', 'view_recipe')
  .text('Add new recipe', 'add_recipe');

/** Recipe save/edit/discard */
export const recipeSaveKeyboard = new InlineKeyboard()
  .text('Save', 'save_recipe')
  .text('Edit something', 'edit_recipe')
  .text('Discard', 'discard_recipe');
