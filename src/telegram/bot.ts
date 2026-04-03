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
} from './keyboards.js';
import type { LLMProvider } from '../ai/provider.js';
import { RecipeDatabase } from '../recipes/database.js';
import { renderRecipe } from '../recipes/renderer.js';
import {
  type RecipeFlowState,
  createRecipeFlowState,
  handleMealTypeSelected,
  handlePreferencesAndGenerate,
  handleRefinement,
  handleSave,
  classifyReviewIntent,
  handleRecipeQuestion,
} from '../agents/recipe-flow.js';

interface BotDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
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
 */
async function reply(ctx: any, text: string, options?: any): Promise<void> {
  const debugFooter = log.getDebugFooter();
  const fullText = text + debugFooter;
  log.telegramOut(fullText);
  await ctx.reply(fullText, options);
}

/**
 * Create and configure the Telegram bot.
 */
export function createBot(deps: BotDeps): Bot {
  const { llm, recipes } = deps;
  const bot = new Bot(config.telegram.botToken);

  // ─── Session state (in-memory for v0.0.1) ──────────────────────────────
  let recipeFlow: RecipeFlowState | null = null;
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
        const recipe = recipes.getBySlug(slug);
        if (recipe) {
          log.debug('FLOW', `recipe view: ${slug}`);
          await reply(ctx, renderRecipe(recipe), { reply_markup: recipeViewKeyboard });
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
      case 'plan_week':
        await reply(ctx, 'Weekly planning is being redesigned. Use My Recipes to build your recipe database first!', { reply_markup: mainMenuKeyboard });
        return;
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
