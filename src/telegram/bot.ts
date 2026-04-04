/**
 * Telegram bot setup and message routing.
 *
 * Routes messages to either:
 * - The recipe generation flow (generate/refine/save)
 * - The planning orchestrator (weekly planning — WIP)
 * - Simple read-only views (recipe list, shopping list, budget)
 *
 * Button taps map directly to flow actions. Free-form text/voice goes through
 * the LLM for interpretation. Voice messages are transcribed via Whisper first.
 *
 * All incoming and outgoing messages are logged to `logs/debug.log` for
 * debugging. In DEBUG mode, outgoing messages include a one-line debug footer
 * showing which AI models were used and how long the operation took.
 */

import { Bot } from 'grammy';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import {
  mainMenuKeyboard,
  mealTypeKeyboard,
  recipeReviewKeyboard,
  recipeListKeyboard,
  recipeViewKeyboard,
  planBreakfastKeyboard,
  planEventsKeyboard,
  planMoreEventsKeyboard,
  planProposalKeyboard,
  planRecipeGapKeyboard,
  planGapRecipeReviewKeyboard,
  planConfirmedKeyboard,
} from './keyboards.js';
import type { LLMProvider } from '../ai/provider.js';
import { RecipeDatabase } from '../recipes/database.js';
import type { Recipe } from '../models/types.js';
import { StateStore } from '../state/store.js';
import { renderRecipe } from '../recipes/renderer.js';
import {
  type RecipeFlowState,
  createRecipeFlowState,
  createEditFlowState,
  handleMealTypeSelected,
  handlePreferencesAndGenerate,
  handleRefinement,
  handleSave,
  classifyReviewIntent,
  handleRecipeQuestion,
} from '../agents/recipe-flow.js';
import {
  type PlanFlowState,
  createPlanFlowState,
  handleNoEvents,
  handleAddEvent,
  handleEventText,
  handleEventsDone,
  handleGenerateProposal,
  handleGapResponse,
  handleGapRecipePrefs,
  handleGapRecipeReview,
  handleGapRecipeRefinement,
  handleApprove,
  handleSwapRequest,
  handleSwapText,
} from '../agents/plan-flow.js';

interface BotDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStore;
}

/**
 * Keep the typing indicator alive during long operations.
 * Telegram's typing action expires after ~5 seconds, so we re-send every 4 seconds.
 * Returns a stop function to call when the operation completes.
 */
function startTypingIndicator(ctx: any): () => void {
  ctx.replyWithChatAction('typing').catch(() => {});
  const interval = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

/**
 * Send a reply through Telegram and log it.
 * In debug mode, appends a debug footer with AI model/timing info.
 * Extracts button labels from the reply_markup (if any) and includes
 * them in the debug log so the full reply context is visible.
 */
async function reply(ctx: any, text: string, options?: any): Promise<void> {
  const debugFooter = log.getDebugFooter();
  const fullText = text + debugFooter;
  const buttons = extractButtons(options?.reply_markup);
  log.telegramOut(fullText, buttons);
  await ctx.reply(fullText, options);
}

/**
 * Extract button labels from a grammy keyboard for debug logging.
 * Handles both InlineKeyboard (.inline_keyboard) and Keyboard (.keyboard).
 * Returns rows of button label strings, or undefined if no keyboard.
 */
function extractButtons(markup: any): string[][] | undefined {
  if (!markup) return undefined;
  const rows: { text: string }[][] = markup.inline_keyboard ?? markup.keyboard;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return rows.map((row) => row.map((btn) => btn.text));
}

/**
 * Create and configure the Telegram bot.
 */
export function createBot(deps: BotDeps): Bot {
  const { llm, recipes, store } = deps;
  const bot = new Bot(config.telegram.botToken);

  // ─── Session state (in-memory for v0.0.1) ──────────────────────────────
  let recipeFlow: RecipeFlowState | null = null;
  let planFlow: PlanFlowState | null = null;
  let recipeListPage = 0;

  // ─── Logging middleware ─────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString() ?? '?';
    const type = ctx.callbackQuery ? 'callback' : ctx.message?.voice ? 'voice' : ctx.message?.text ? 'text' : 'other';
    const data = ctx.callbackQuery?.data ?? ctx.message?.text?.slice(0, 80) ?? '(voice/other)';
    log.telegramIn(type, `chat=${chatId} ${data}`);
    await next();
  });

  // ─── Auth middleware ───────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== config.telegram.chatId) {
      log.debug('AUTH', `Rejected message from chat ${chatId}`);
      return;
    }
    await next();
  });

  // ─── /start command ────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    recipeFlow = null;
    await reply(ctx, 'Welcome to Flexie! Use the menu below to get started.', {
      reply_markup: mainMenuKeyboard,
    });
  });

  // ─── /cancel command ───────────────────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    recipeFlow = null;
    await reply(ctx, 'Cancelled.', { reply_markup: mainMenuKeyboard });
  });

  // ─── Callback queries (button taps) ────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    try {
      const action = ctx.callbackQuery.data;
      log.debug('FLOW', `callback: ${action}`);
      await ctx.answerCallbackQuery();

      // Meal type selection
      if (action.startsWith('meal_type_')) {
        const mealType = action.replace('meal_type_', '') as 'breakfast' | 'lunch' | 'dinner';
        if (!recipeFlow) recipeFlow = createRecipeFlowState();
        const result = handleMealTypeSelected(recipeFlow, mealType);
        recipeFlow = result.state;
        await reply(ctx, result.text);
        return;
      }

      // Recipe review actions
      if (action === 'save_recipe') {
        if (recipeFlow?.currentRecipe) {
          const result = await handleSave(recipeFlow, recipes);
          log.debug('FLOW', `recipe saved: ${recipeFlow.currentRecipe.name}`);
          recipeFlow = null;
          await reply(ctx, result.text, { reply_markup: mainMenuKeyboard });
        }
        return;
      }

      if (action === 'refine_recipe') {
        if (recipeFlow) {
          recipeFlow.phase = 'awaiting_refinement';
          log.debug('FLOW', 'phase → awaiting_refinement');
          await reply(ctx, 'What would you like to change? (e.g., "simpler ingredients", "less fat", "swap chicken for fish")');
        }
        return;
      }

      if (action === 'new_recipe') {
        recipeFlow = createRecipeFlowState();
        log.debug('FLOW', 'new recipe flow started');
        await reply(ctx, 'What type of recipe?', { reply_markup: mealTypeKeyboard });
        return;
      }

      if (action === 'discard_recipe') {
        recipeFlow = null;
        log.debug('FLOW', 'recipe discarded');
        await reply(ctx, 'Discarded.', { reply_markup: mainMenuKeyboard });
        return;
      }

      // Recipe browse actions
      if (action === 'add_recipe') {
        recipeFlow = createRecipeFlowState();
        log.debug('FLOW', 'add recipe from browse');
        await reply(ctx, 'What type of recipe?', { reply_markup: mealTypeKeyboard });
        return;
      }

      // Recipe list: view a specific recipe by slug
      if (action.startsWith('rv_')) {
        const slug = action.slice(3);
        const recipe = recipes.getBySlug(slug) ?? findBySlugPrefix(recipes, slug);
        if (recipe) {
          log.debug('FLOW', `recipe view: ${slug}`);
          await reply(ctx, renderRecipe(recipe), { reply_markup: recipeViewKeyboard(slug) });
        } else {
          await reply(ctx, 'Recipe not found.', { reply_markup: mainMenuKeyboard });
        }
        return;
      }

      // Recipe delete
      if (action.startsWith('rd_')) {
        const slug = action.slice(3);
        const recipe = recipes.getBySlug(slug) ?? findBySlugPrefix(recipes, slug);
        if (recipe) {
          await recipes.remove(recipe.slug);
          log.info('DB', `Recipe deleted: "${recipe.name}" (${recipe.slug})`);
          await reply(ctx, `Deleted "${recipe.name}".`);
          recipeListPage = 0;
          await showRecipeList(ctx);
        } else {
          await reply(ctx, 'Recipe not found.', { reply_markup: mainMenuKeyboard });
        }
        return;
      }

      // Recipe edit — load into refine flow
      if (action.startsWith('re_')) {
        const slug = action.slice(3);
        const recipe = recipes.getBySlug(slug) ?? findBySlugPrefix(recipes, slug);
        if (recipe) {
          planFlow = null;
          recipeFlow = createEditFlowState(recipe);
          log.debug('FLOW', `editing recipe: ${slug}`);
          await reply(ctx, 'What would you like to change? (e.g., "swap beef for chicken", "less oil", "add a side salad")');
        } else {
          await reply(ctx, 'Recipe not found.', { reply_markup: mainMenuKeyboard });
        }
        return;
      }

      // Recipe list: page navigation
      if (action.startsWith('rp_')) {
        const param = action.slice(3);
        if (param === 'noop') return; // page indicator button, do nothing
        const page = parseInt(param, 10);
        if (!isNaN(page)) {
          recipeListPage = page;
          await showRecipeList(ctx);
        }
        return;
      }

      // Back to recipe list from recipe view
      if (action === 'recipe_back') {
        await showRecipeList(ctx);
        return;
      }

      // Post-plan-confirmation actions
      if (action === 'view_shopping_list') {
        planFlow = null;
        await reply(ctx, 'Shopping list generation is coming soon!', { reply_markup: mainMenuKeyboard });
        return;
      }
      if (action === 'view_plan_recipes') {
        planFlow = null;
        recipeListPage = 0;
        await showRecipeList(ctx);
        return;
      }

      // ─── Plan flow callbacks ──────────────────────────────────────────
      if (action.startsWith('plan_') && planFlow) {
        log.startOperation();

        // Breakfast confirmation
        if (action === 'plan_keep_breakfast') {
          log.debug('FLOW', 'breakfast kept');
          await reply(ctx, `✓ Breakfast: ${planFlow.breakfast.name}\n\nAny meals out or social events this week?`, {
            reply_markup: planEventsKeyboard,
          });
          return;
        }

        if (action === 'plan_change_breakfast') {
          // TODO: breakfast change flow (rare path, v0.0.1 keeps it simple)
          await reply(ctx, 'Breakfast changes are coming soon. Keeping current breakfast for now.\n\nAny meals out or social events this week?', {
            reply_markup: planEventsKeyboard,
          });
          return;
        }

        // Events
        if (action === 'plan_no_events') {
          const result = handleNoEvents(planFlow);
          planFlow = result.state;
          await reply(ctx, result.text);
          const stopTyping = startTypingIndicator(ctx);
          try {
            const proposal = await handleGenerateProposal(planFlow, llm, recipes, store);
            planFlow = proposal.state;
            stopTyping();
            const kb = planFlow.phase === 'recipe_suggestion'
              ? planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)
              : planProposalKeyboard;
            await reply(ctx, proposal.text, { reply_markup: kb });
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }

        if (action === 'plan_add_event') {
          const result = handleAddEvent(planFlow);
          planFlow = result.state;
          await reply(ctx, result.text);
          return;
        }

        if (action === 'plan_events_done') {
          const doneResult = handleEventsDone(planFlow);
          planFlow = doneResult.state;
          await reply(ctx, doneResult.text);
          const stopTyping = startTypingIndicator(ctx);
          try {
            const proposal = await handleGenerateProposal(planFlow, llm, recipes, store);
            planFlow = proposal.state;
            stopTyping();
            const kb = planFlow.phase === 'recipe_suggestion'
              ? planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)
              : planProposalKeyboard;
            await reply(ctx, proposal.text, { reply_markup: kb });
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }

        // Plan proposal actions
        if (action === 'plan_approve') {
          const stopTyping = startTypingIndicator(ctx);
          try {
            const result = await handleApprove(planFlow, store);
            planFlow = result.state;
            stopTyping();
            await reply(ctx, result.text, { reply_markup: planConfirmedKeyboard });
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }

        if (action === 'plan_swap') {
          const result = handleSwapRequest(planFlow);
          planFlow = result.state;
          await reply(ctx, result.text);
          return;
        }

        if (action === 'plan_cancel') {
          planFlow = null;
          await reply(ctx, 'Planning cancelled.', { reply_markup: mainMenuKeyboard });
          return;
        }

        // Recipe gap actions
        if (action.startsWith('plan_gen_gap_')) {
          const gapIndex = parseInt(action.replace('plan_gen_gap_', ''), 10);
          planFlow.activeGapIndex = gapIndex;
          await reply(ctx, 'Generating recipe...');
          const stopTyping = startTypingIndicator(ctx);
          try {
            const result = await handleGapResponse(planFlow, 'generate', llm, recipes);
            planFlow = result.state;
            stopTyping();
            const kb = planFlow.phase === 'reviewing_recipe'
              ? planGapRecipeReviewKeyboard
              : planFlow.phase === 'recipe_suggestion'
              ? planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)
              : planProposalKeyboard;
            await reply(ctx, result.text, { reply_markup: kb });
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }

        if (action.startsWith('plan_idea_gap_')) {
          const gapIndex = parseInt(action.replace('plan_idea_gap_', ''), 10);
          planFlow.activeGapIndex = gapIndex;
          const result = await handleGapResponse(planFlow, 'idea', llm, recipes);
          planFlow = result.state;
          await reply(ctx, result.text);
          return;
        }

        if (action.startsWith('plan_skip_gap_')) {
          const gapIndex = parseInt(action.replace('plan_skip_gap_', ''), 10);
          planFlow.activeGapIndex = gapIndex;
          const result = await handleGapResponse(planFlow, 'skip', llm, recipes);
          planFlow = result.state;
          const kb = planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await reply(ctx, result.text, { reply_markup: kb });
          return;
        }

        // Gap recipe review
        if (action === 'plan_use_recipe') {
          const result = await handleGapRecipeReview(planFlow, 'use', recipes, llm);
          planFlow = result.state;
          const kb = planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await reply(ctx, result.text, { reply_markup: kb });
          return;
        }

        if (action === 'plan_diff_recipe') {
          await reply(ctx, 'Generating a different recipe...');
          const stopTyping = startTypingIndicator(ctx);
          try {
            const result = await handleGapRecipeReview(planFlow, 'different', recipes, llm);
            planFlow = result.state;
            stopTyping();
            await reply(ctx, result.text, { reply_markup: planGapRecipeReviewKeyboard });
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }
      }

    } catch (err) {
      log.error('BOT', 'Callback error', err);
      await reply(ctx, 'Something went wrong. Try again.');
    }
  });

  // ─── Voice messages ────────────────────────────────────────────────────
  bot.on('message:voice', async (ctx) => {
    try {
      log.startOperation();
      const stopTyping = startTypingIndicator(ctx);
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const audioResponse = await fetch(url);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      const text = await llm.transcribe(audioBuffer);
      stopTyping();
      log.debug('FLOW', `voice transcribed: "${text}"`);
      await handleTextInput(ctx, text);
    } catch (err) {
      log.error('BOT', 'Voice message error', err);
      await reply(ctx, 'Something went wrong with the voice message. Try typing instead.');
    }
  });

  // ─── Text messages ─────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    try {
      const text = ctx.message.text;

      // Main menu buttons
      const menuAction = matchMainMenu(text);
      if (menuAction) {
        log.debug('FLOW', `menu: ${menuAction}`);
        await handleMenu(ctx, menuAction);
        return;
      }

      await handleTextInput(ctx, text);
    } catch (err) {
      log.error('BOT', 'Text message error', err);
      await reply(ctx, 'Something went wrong. Try again.');
    }
  });

  // ─── Internal handlers ─────────────────────────────────────────────────

  async function handleMenu(ctx: any, action: string) {
    recipeFlow = null; // exit any active flow
    planFlow = null;

    switch (action) {
      case 'my_recipes': {
        const all = recipes.getAll();
        if (all.length === 0) {
          recipeFlow = createRecipeFlowState();
          await reply(ctx, 'No recipes yet. Let\'s create your first one!\n\nWhat type?', {
            reply_markup: mealTypeKeyboard,
          });
        } else {
          recipeListPage = 0;
          await showRecipeList(ctx);
        }
        return;
      }
      case 'plan_week': {
        // Check if we have lunch/dinner recipes to plan with
        const lunchDinnerRecipes = recipes.getAll().filter(
          (r) => r.mealTypes.includes('lunch') || r.mealTypes.includes('dinner'),
        );
        if (lunchDinnerRecipes.length === 0) {
          await reply(ctx, 'You need some lunch/dinner recipes first. Add a few, then come back to plan your week!', { reply_markup: mainMenuKeyboard });
          return;
        }

        // Calculate week start (this Monday if today is Mon, otherwise next Monday)
        const weekStart = getNextWeekStart();

        // Load breakfast from last plan or find a breakfast recipe in DB
        const lastPlan = await store.getCurrentPlan() ?? await store.getLastCompletedPlan();
        const breakfastRecipes = recipes.getByMealType('breakfast');
        const breakfast = lastPlan?.breakfast
          ? {
              recipeSlug: lastPlan.breakfast.recipeSlug,
              name: recipes.getBySlug(lastPlan.breakfast.recipeSlug)?.name ?? 'Your breakfast',
              caloriesPerDay: lastPlan.breakfast.caloriesPerDay,
              proteinPerDay: lastPlan.breakfast.proteinPerDay,
            }
          : breakfastRecipes.length > 0
          ? {
              recipeSlug: breakfastRecipes[0]!.slug,
              name: breakfastRecipes[0]!.name,
              caloriesPerDay: breakfastRecipes[0]!.perServing.calories,
              proteinPerDay: breakfastRecipes[0]!.perServing.protein,
            }
          : {
              recipeSlug: 'default-breakfast',
              name: 'Breakfast',
              caloriesPerDay: Math.round(config.targets.daily.calories * 0.27),
              proteinPerDay: Math.round(config.targets.daily.protein * 0.27),
            };

        planFlow = createPlanFlowState(weekStart, breakfast);
        log.debug('FLOW', `plan week started: ${weekStart}, breakfast: ${breakfast.name}`);

        const weekEnd = planFlow.weekDays[6]!;
        const startStr = formatDateForMessage(weekStart);
        const endStr = formatDateForMessage(weekEnd);

        await reply(ctx, `Planning ${startStr} – ${endStr}.\n\nBreakfast: keep ${breakfast.name} (${breakfast.caloriesPerDay} cal/day)?`, {
          reply_markup: planBreakfastKeyboard,
        });
        return;
      }
      case 'shopping_list':
        await reply(ctx, 'No active plan yet. Plan your week first!', { reply_markup: mainMenuKeyboard });
        return;
      case 'weekly_budget':
        await reply(ctx, 'No active plan yet.', { reply_markup: mainMenuKeyboard });
        return;
    }
  }

  /**
   * Show the paginated recipe list for the current page.
   * Displays recipe names as a text list with tappable inline buttons below.
   */
  async function showRecipeList(ctx: any) {
    const all = recipes.getAll();
    const pageSize = 5;

    await reply(ctx, `Your recipes (${all.length}):`, {
      reply_markup: recipeListKeyboard(all, recipeListPage, pageSize),
    });
  }

  async function handleTextInput(ctx: any, text: string) {
    // If in plan flow, route there first
    if (planFlow) {
      log.startOperation();

      if (planFlow.phase === 'awaiting_events') {
        const stopTyping = startTypingIndicator(ctx);
        try {
          const result = await handleEventText(planFlow, text, llm);
          planFlow = result.state;
          stopTyping();
          await reply(ctx, result.text, { reply_markup: planMoreEventsKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (planFlow.phase === 'awaiting_recipe_prefs') {
        await reply(ctx, 'Generating recipe...');
        const stopTyping = startTypingIndicator(ctx);
        try {
          const result = await handleGapRecipePrefs(planFlow, text, llm);
          planFlow = result.state;
          stopTyping();
          const kb = planFlow.phase === 'reviewing_recipe'
            ? planGapRecipeReviewKeyboard
            : planProposalKeyboard;
          await reply(ctx, result.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (planFlow.phase === 'awaiting_swap') {
        const stopTyping = startTypingIndicator(ctx);
        try {
          const result = await handleSwapText(planFlow, text, llm, recipes, store);
          planFlow = result.state;
          stopTyping();
          const kb = planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await reply(ctx, result.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (planFlow.phase === 'reviewing_recipe') {
        // User is typing a refinement for the gap recipe (e.g., "swap avocado oil with olive oil")
        await reply(ctx, 'Refining recipe...');
        const stopTyping = startTypingIndicator(ctx);
        try {
          const result = await handleGapRecipeRefinement(planFlow, text, llm);
          planFlow = result.state;
          stopTyping();
          await reply(ctx, result.text, { reply_markup: planGapRecipeReviewKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      // Plan flow active but not awaiting text — ignore
      return;
    }

    // If in recipe flow, route there
    if (recipeFlow) {

      if (recipeFlow.phase === 'awaiting_preferences') {
        log.startOperation();
        await reply(ctx, 'Generating your recipe — this usually takes a minute or two...');
        const stopTyping = startTypingIndicator(ctx);
        try {
          const result = await handlePreferencesAndGenerate(recipeFlow, text, llm);
          recipeFlow = result.state;
          stopTyping();
          await reply(ctx, result.text, { reply_markup: recipeReviewKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (recipeFlow.phase === 'awaiting_refinement') {
        log.startOperation();
        await reply(ctx, 'Refining your recipe...');
        const stopTyping = startTypingIndicator(ctx);
        try {
          const result = await handleRefinement(recipeFlow, text, llm);
          recipeFlow = result.state;
          stopTyping();
          await reply(ctx, result.text, { reply_markup: recipeReviewKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (recipeFlow.phase === 'reviewing') {
        log.startOperation();
        // Classify intent: is this a question or a refinement request?
        const stopTyping = startTypingIndicator(ctx);
        const intent = await classifyReviewIntent(text, llm);
        log.debug('FLOW', `review intent: ${intent}`);

        if (intent === 'question') {
          try {
            const result = await handleRecipeQuestion(recipeFlow, text, llm);
            recipeFlow = result.state;
            stopTyping();
            await reply(ctx, result.text);
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }

        // It's a refinement — generate updated recipe
        stopTyping();
        await reply(ctx, 'Refining your recipe...');
        const stopTyping2 = startTypingIndicator(ctx);
        try {
          const result = await handleRefinement(recipeFlow, text, llm);
          recipeFlow = result.state;
          stopTyping2();
          await reply(ctx, result.text, { reply_markup: recipeReviewKeyboard });
        } catch (err) {
          stopTyping2();
          throw err;
        }
        return;
      }
    }

    // Not in a flow — check if they want to view a specific recipe
    const recipe = recipes.getAll().find(
      (r) => r.name.toLowerCase().includes(text.toLowerCase()) || r.slug.includes(text.toLowerCase())
    );
    if (recipe) {
      log.debug('FLOW', `recipe lookup: "${text}" → ${recipe.slug}`);
      await reply(ctx, renderRecipe(recipe));
      return;
    }

    await reply(ctx, 'Use the menu buttons below to get started.', { reply_markup: mainMenuKeyboard });
  }

  return bot;
}

function matchMainMenu(text: string): string | null {
  const menuMap: Record<string, string> = {
    '📋 Plan Week': 'plan_week',
    '🛒 Shopping List': 'shopping_list',
    '📖 My Recipes': 'my_recipes',
    '📊 Weekly Budget': 'weekly_budget',
  };
  return menuMap[text] ?? null;
}

/**
 * Calculate the start date for the plan week.
 * If today is Monday, plan this week. Otherwise, plan next Monday.
 */
function getNextWeekStart(): string {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sun, 1 = Mon, ...
  let daysUntilMonday: number;
  if (dayOfWeek === 1) {
    daysUntilMonday = 0; // today is Monday
  } else if (dayOfWeek === 0) {
    daysUntilMonday = 1; // tomorrow is Monday
  } else {
    daysUntilMonday = 8 - dayOfWeek; // next Monday
  }
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMonday);
  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, '0');
  const day = String(monday.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Format a date for display in messages. */
function formatDateForMessage(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Find a recipe by slug prefix. Used when callback data was truncated to fit
 * Telegram's 64-byte limit. Returns the first recipe whose slug starts with
 * the given prefix, or undefined if no match.
 */
function findBySlugPrefix(db: RecipeDatabase, prefix: string): Recipe | undefined {
  return db.getAll().find((r) => r.slug.startsWith(prefix));
}
