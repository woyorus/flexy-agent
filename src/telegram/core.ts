/**
 * BotCore — headless dispatch layer for Telegram bot logic.
 *
 * This module contains ALL of the bot's conversation logic, extracted from the
 * grammY adapter (`src/telegram/bot.ts`) so that the same logic can be driven
 * by two different front-ends:
 *
 *   1. `src/telegram/bot.ts` — the real grammY bot in production. Translates
 *      grammY `Context` objects into `HarnessUpdate` values, constructs a
 *      `grammyOutputSink`, and calls `core.dispatch(update, sink)`.
 *
 *   2. `src/harness/runner.ts` — the test harness. Feeds `HarnessUpdate`
 *      events directly into `dispatch`, captures outputs via a
 *      `CapturingOutputSink`, and asserts on the full transcript + session
 *      state + store snapshot. No grammY involved.
 *
 * ## What lives here (the core):
 *
 *   - Every handler body from the previous monolithic `bot.ts`: /start,
 *     /cancel, inline-button callbacks (meal type, recipe review, recipe
 *     list navigation, plan flow buttons, gap resolution), main-menu reply
 *     buttons, free-form text routing, voice-after-transcription dispatch.
 *   - The in-memory session state: `recipeFlow`, `planFlow`, `recipeListPage`.
 *   - Error handling: each top-level update is wrapped so a thrown error
 *     produces a "Something went wrong" reply instead of crashing the sink.
 *
 * ## What deliberately does NOT live here:
 *
 *   - Debug footer computation. `log.getDebugFooter()` is timing-dependent
 *     and reads process-global state (`operationEvents`, `operationStart` in
 *     `src/debug/logger.ts`). Calling it from core logic would make captured
 *     transcripts non-deterministic across runs. The grammY adapter appends
 *     the footer exclusively inside its own sink implementation, so real
 *     Telegram users still see timings while the harness transcript stays
 *     byte-stable regardless of DEBUG mode.
 *
 *   - `log.telegramIn` / `log.telegramOut` / `log.startOperation`. These are
 *     adapter-level concerns: the grammY middleware logs inbound messages
 *     and starts the operation timer; the grammY sink logs outbound text.
 *     The harness sink never writes to `logs/debug.log`.
 *
 *   - Voice transcription. The grammY adapter downloads the audio and calls
 *     `llm.transcribe()`, then dispatches `{ type: 'voice', transcribedText }`.
 *     Core never sees raw audio — scenarios pre-supply the transcribed text.
 *
 *   - Auth. The grammY adapter rejects messages from unauthorized chat IDs
 *     before they reach `dispatch`.
 *
 * ## HarnessUpdate variants:
 *
 *   - `command`: a Telegram `/command` with optional args (e.g. `/start`).
 *   - `text`: a plain text message. This covers both free-form user text AND
 *     reply-keyboard taps (main menu buttons send their labels as text).
 *   - `callback`: an inline-keyboard button tap carrying `callback_data`.
 *   - `voice`: a voice message that has already been transcribed upstream.
 *
 * ## OutputSink contract:
 *
 *   `OutputSink` mirrors the subset of grammY `Context` that handlers use:
 *   reply-with-optional-keyboard, answer-callback, start-typing. Handlers
 *   pass their existing `Keyboard` / `InlineKeyboard` instances verbatim; the
 *   sink implementation decides whether to forward them to Telegram or
 *   capture them for assertions.
 */

import type { Keyboard, InlineKeyboard } from 'grammy';
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
import type { RecipeDatabase } from '../recipes/database.js';
import type { Recipe } from '../models/types.js';
import type { StateStoreLike } from '../state/store.js';
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

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * A single update handed to `BotCore.dispatch`. Adapters translate their
 * native event shape (grammY `Context`, harness scenario event) into one of
 * these variants.
 *
 * `voice` carries pre-transcribed text — the harness never replays audio, and
 * the grammY adapter runs Whisper before dispatch.
 */
export type HarnessUpdate =
  | { type: 'command'; command: string; args?: string }
  | { type: 'text'; text: string }
  | { type: 'callback'; data: string }
  | { type: 'voice'; transcribedText: string };

/**
 * Minimal surface the core needs from a sink. grammY adapters forward to
 * `ctx.reply` / `ctx.answerCallbackQuery`; the harness sink records calls.
 *
 * Handlers pass their existing grammY keyboard instances as
 * `options.reply_markup` so the structural extraction is zero-churn for every
 * call site. The harness sink is responsible for serializing those instances
 * into a comparable shape.
 */
export interface OutputSink {
  reply(text: string, options?: { reply_markup?: Keyboard | InlineKeyboard }): Promise<void>;
  answerCallback(): Promise<void>;
  /** Start a typing indicator. Returns a stop function to call on completion. */
  startTyping(): () => void;
}

/**
 * Dependencies the core needs. `store` is typed against the interface rather
 * than the concrete `StateStore` class so that `TestStateStore` can be swapped
 * in during scenario replay without touching production code.
 */
export interface BotCoreDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStoreLike;
}

/**
 * In-memory session state. Hoisted from the previous closure-scoped variables
 * in `bot.ts` so that the harness can seed initial values and inspect the
 * final state for assertions.
 */
export interface BotCoreSession {
  recipeFlow: RecipeFlowState | null;
  planFlow: PlanFlowState | null;
  recipeListPage: number;
}

/**
 * The headless bot. `session` is mutated in place across dispatches, the
 * same way the old closure-scoped variables were. `reset()` clears all three
 * fields (used by the harness between scenarios — production never resets).
 */
export interface BotCore {
  session: BotCoreSession;
  dispatch(update: HarnessUpdate, sink: OutputSink): Promise<void>;
  reset(): void;
}

// ─── Core factory ────────────────────────────────────────────────────────────

/**
 * Construct a `BotCore` bound to the given dependencies. Returns an object
 * whose `dispatch` method is the single entry point for all updates; the
 * grammY adapter and the harness runner both call this exclusively.
 *
 * Session state lives on `core.session` and is mutated in place as handlers
 * progress. No persistence here beyond what the handlers do explicitly via
 * `deps.store.*`.
 */
export function createBotCore(deps: BotCoreDeps): BotCore {
  const { llm, recipes, store } = deps;

  const session: BotCoreSession = {
    recipeFlow: null,
    planFlow: null,
    recipeListPage: 0,
  };

  // ─── Dispatch ──────────────────────────────────────────────────────────
  //
  // No try/catch here. Errors propagate to the adapter:
  //
  //   - grammY adapter (`src/telegram/bot.ts`) wraps each handler in a
  //     try/catch that logs and replies "Something went wrong" so the user
  //     sees a friendly message and the bot stays alive.
  //   - Harness runner/generator lets the error propagate — scenarios fail
  //     loudly on any unhandled error, which is the whole point of the
  //     closed feedback loop. A silent "Something went wrong" reply would
  //     otherwise poison the captured transcript and match on the wrong
  //     fixture on the next run.
  async function dispatch(update: HarnessUpdate, sink: OutputSink): Promise<void> {
    switch (update.type) {
      case 'command':
        await handleCommand(update.command, sink);
        return;
      case 'callback':
        await handleCallback(update.data, sink);
        return;
      case 'voice':
        // Voice is just pre-transcribed text routed through the same path.
        await handleTextInput(update.transcribedText, sink);
        return;
      case 'text': {
        // Main menu reply-keyboard taps arrive as text (the button label).
        const menuAction = matchMainMenu(update.text);
        if (menuAction) {
          log.debug('FLOW', `menu: ${menuAction}`);
          await handleMenu(menuAction, sink);
          return;
        }
        await handleTextInput(update.text, sink);
        return;
      }
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────
  async function handleCommand(command: string, sink: OutputSink): Promise<void> {
    if (command === 'start') {
      session.recipeFlow = null;
      await sink.reply('Welcome to Flexie! Use the menu below to get started.', {
        reply_markup: mainMenuKeyboard,
      });
      return;
    }
    if (command === 'cancel') {
      session.recipeFlow = null;
      await sink.reply('Cancelled.', { reply_markup: mainMenuKeyboard });
      return;
    }
  }

  // ─── Callbacks (inline keyboard taps) ──────────────────────────────────
  async function handleCallback(action: string, sink: OutputSink): Promise<void> {
    log.debug('FLOW', `callback: ${action}`);
    await sink.answerCallback();

    // Meal type selection
    if (action.startsWith('meal_type_')) {
      const mealType = action.replace('meal_type_', '') as 'breakfast' | 'lunch' | 'dinner';
      if (!session.recipeFlow) session.recipeFlow = createRecipeFlowState();
      const result = handleMealTypeSelected(session.recipeFlow, mealType);
      session.recipeFlow = result.state;
      await sink.reply(result.text);
      return;
    }

    // Recipe review actions
    if (action === 'save_recipe') {
      if (session.recipeFlow?.currentRecipe) {
        const result = await handleSave(session.recipeFlow, recipes);
        log.debug('FLOW', `recipe saved: ${session.recipeFlow.currentRecipe.name}`);
        session.recipeFlow = null;
        await sink.reply(result.text, { reply_markup: mainMenuKeyboard });
      }
      return;
    }

    if (action === 'refine_recipe') {
      if (session.recipeFlow) {
        session.recipeFlow.phase = 'awaiting_refinement';
        log.debug('FLOW', 'phase → awaiting_refinement');
        await sink.reply('What would you like to change? (e.g., "simpler ingredients", "less fat", "swap chicken for fish")');
      }
      return;
    }

    if (action === 'new_recipe') {
      session.recipeFlow = createRecipeFlowState();
      log.debug('FLOW', 'new recipe flow started');
      await sink.reply('What type of recipe?', { reply_markup: mealTypeKeyboard });
      return;
    }

    if (action === 'discard_recipe') {
      session.recipeFlow = null;
      log.debug('FLOW', 'recipe discarded');
      await sink.reply('Discarded.', { reply_markup: mainMenuKeyboard });
      return;
    }

    // Recipe browse actions
    if (action === 'add_recipe') {
      session.recipeFlow = createRecipeFlowState();
      log.debug('FLOW', 'add recipe from browse');
      await sink.reply('What type of recipe?', { reply_markup: mealTypeKeyboard });
      return;
    }

    // Recipe list: view a specific recipe by slug
    if (action.startsWith('rv_')) {
      const slug = action.slice(3);
      const recipe = recipes.getBySlug(slug) ?? findBySlugPrefix(recipes, slug);
      if (recipe) {
        log.debug('FLOW', `recipe view: ${slug}`);
        await sink.reply(renderRecipe(recipe), { reply_markup: recipeViewKeyboard(slug) });
      } else {
        await sink.reply('Recipe not found.', { reply_markup: mainMenuKeyboard });
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
        await sink.reply(`Deleted "${recipe.name}".`);
        session.recipeListPage = 0;
        await showRecipeList(sink);
      } else {
        await sink.reply('Recipe not found.', { reply_markup: mainMenuKeyboard });
      }
      return;
    }

    // Recipe edit — load into refine flow
    if (action.startsWith('re_')) {
      const slug = action.slice(3);
      const recipe = recipes.getBySlug(slug) ?? findBySlugPrefix(recipes, slug);
      if (recipe) {
        session.planFlow = null;
        session.recipeFlow = createEditFlowState(recipe);
        log.debug('FLOW', `editing recipe: ${slug}`);
        await sink.reply('What would you like to change? (e.g., "swap beef for chicken", "less oil", "add a side salad")');
      } else {
        await sink.reply('Recipe not found.', { reply_markup: mainMenuKeyboard });
      }
      return;
    }

    // Recipe list: page navigation
    if (action.startsWith('rp_')) {
      const param = action.slice(3);
      if (param === 'noop') return; // page indicator button, no-op
      const page = parseInt(param, 10);
      if (!isNaN(page)) {
        session.recipeListPage = page;
        await showRecipeList(sink);
      }
      return;
    }

    // Back to recipe list from recipe view
    if (action === 'recipe_back') {
      await showRecipeList(sink);
      return;
    }

    // Post-plan-confirmation actions
    if (action === 'view_shopping_list') {
      session.planFlow = null;
      await sink.reply('Shopping list generation is coming soon!', { reply_markup: mainMenuKeyboard });
      return;
    }
    if (action === 'view_plan_recipes') {
      session.planFlow = null;
      session.recipeListPage = 0;
      await showRecipeList(sink);
      return;
    }

    // ─── Plan flow callbacks ────────────────────────────────────────────
    if (action.startsWith('plan_') && session.planFlow) {
      // Breakfast confirmation
      if (action === 'plan_keep_breakfast') {
        log.debug('FLOW', 'breakfast kept');
        await sink.reply(
          `✓ Breakfast: ${session.planFlow.breakfast.name}\n\nAny meals you'll eat out this week? (restaurants, dinner parties, etc.)`,
          { reply_markup: planEventsKeyboard },
        );
        return;
      }

      if (action === 'plan_change_breakfast') {
        // TODO: breakfast change flow (rare path, v0.0.1 keeps it simple)
        await sink.reply(
          "Breakfast changes are coming soon. Keeping current breakfast for now.\n\nAny meals you'll eat out this week? (restaurants, dinner parties, etc.)",
          { reply_markup: planEventsKeyboard },
        );
        return;
      }

      // Events
      if (action === 'plan_no_events') {
        const result = handleNoEvents(session.planFlow);
        session.planFlow = result.state;
        await sink.reply(result.text);
        const stopTyping = sink.startTyping();
        try {
          const proposal = await handleGenerateProposal(session.planFlow, llm, recipes, store);
          session.planFlow = proposal.state;
          stopTyping();
          const kb = session.planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(session.planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await sink.reply(proposal.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (action === 'plan_add_event') {
        const result = handleAddEvent(session.planFlow);
        session.planFlow = result.state;
        await sink.reply(result.text);
        return;
      }

      if (action === 'plan_events_done') {
        const doneResult = handleEventsDone(session.planFlow);
        session.planFlow = doneResult.state;
        await sink.reply(doneResult.text);
        const stopTyping = sink.startTyping();
        try {
          const proposal = await handleGenerateProposal(session.planFlow, llm, recipes, store);
          session.planFlow = proposal.state;
          stopTyping();
          const kb = session.planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(session.planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await sink.reply(proposal.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      // Plan proposal actions
      if (action === 'plan_approve') {
        const stopTyping = sink.startTyping();
        try {
          const result = await handleApprove(session.planFlow, store, recipes, llm);
          session.planFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: planConfirmedKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (action === 'plan_swap') {
        const result = handleSwapRequest(session.planFlow);
        session.planFlow = result.state;
        await sink.reply(result.text);
        return;
      }

      if (action === 'plan_cancel') {
        session.planFlow = null;
        await sink.reply('Planning cancelled.', { reply_markup: mainMenuKeyboard });
        return;
      }

      // Recipe gap actions
      if (action.startsWith('plan_gen_gap_')) {
        const gapIndex = parseInt(action.replace('plan_gen_gap_', ''), 10);
        session.planFlow.activeGapIndex = gapIndex;
        await sink.reply('Generating recipe...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handleGapResponse(session.planFlow, 'generate', llm, recipes);
          session.planFlow = result.state;
          stopTyping();
          const kb = session.planFlow.phase === 'reviewing_recipe'
            ? planGapRecipeReviewKeyboard
            : session.planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(session.planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await sink.reply(result.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (action.startsWith('plan_idea_gap_')) {
        const gapIndex = parseInt(action.replace('plan_idea_gap_', ''), 10);
        session.planFlow.activeGapIndex = gapIndex;
        const result = await handleGapResponse(session.planFlow, 'idea', llm, recipes);
        session.planFlow = result.state;
        await sink.reply(result.text);
        return;
      }

      if (action.startsWith('plan_skip_gap_')) {
        const gapIndex = parseInt(action.replace('plan_skip_gap_', ''), 10);
        session.planFlow.activeGapIndex = gapIndex;
        const result = await handleGapResponse(session.planFlow, 'skip', llm, recipes);
        session.planFlow = result.state;
        const kb = session.planFlow.phase === 'recipe_suggestion'
          ? planRecipeGapKeyboard(session.planFlow.activeGapIndex ?? 0)
          : planProposalKeyboard;
        await sink.reply(result.text, { reply_markup: kb });
        return;
      }

      // Gap recipe review
      if (action === 'plan_use_recipe') {
        const result = await handleGapRecipeReview(session.planFlow, 'use', recipes, llm);
        session.planFlow = result.state;
        const kb = session.planFlow.phase === 'recipe_suggestion'
          ? planRecipeGapKeyboard(session.planFlow.activeGapIndex ?? 0)
          : planProposalKeyboard;
        await sink.reply(result.text, { reply_markup: kb });
        return;
      }

      if (action === 'plan_diff_recipe') {
        await sink.reply('Generating a different recipe...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handleGapRecipeReview(session.planFlow, 'different', recipes, llm);
          session.planFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: planGapRecipeReviewKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }
    }
  }

  // ─── Main-menu reply-button handling ───────────────────────────────────
  async function handleMenu(action: string, sink: OutputSink): Promise<void> {
    session.recipeFlow = null; // exit any active flow
    session.planFlow = null;

    switch (action) {
      case 'my_recipes': {
        const all = recipes.getAll();
        if (all.length === 0) {
          session.recipeFlow = createRecipeFlowState();
          await sink.reply("No recipes yet. Let's create your first one!\n\nWhat type?", {
            reply_markup: mealTypeKeyboard,
          });
        } else {
          session.recipeListPage = 0;
          await showRecipeList(sink);
        }
        return;
      }
      case 'plan_week': {
        // Check if we have lunch/dinner recipes to plan with
        const lunchDinnerRecipes = recipes
          .getAll()
          .filter((r) => r.mealTypes.includes('lunch') || r.mealTypes.includes('dinner'));
        if (lunchDinnerRecipes.length === 0) {
          await sink.reply(
            'You need some lunch/dinner recipes first. Add a few, then come back to plan your week!',
            { reply_markup: mainMenuKeyboard },
          );
          return;
        }

        // Calculate week start (this Monday if today is Mon, otherwise next Monday)
        const weekStart = getNextWeekStart();

        // Load breakfast from last plan or find a breakfast recipe in DB
        const lastPlan = (await store.getCurrentPlan()) ?? (await store.getLastCompletedPlan());
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

        session.planFlow = createPlanFlowState(weekStart, breakfast);
        log.debug('FLOW', `plan week started: ${weekStart}, breakfast: ${breakfast.name}`);

        const weekEnd = session.planFlow.weekDays[6]!;
        const startStr = formatDateForMessage(weekStart);
        const endStr = formatDateForMessage(weekEnd);

        await sink.reply(
          `Planning ${startStr} – ${endStr}.\n\nBreakfast: keep ${breakfast.name} (${breakfast.caloriesPerDay} cal/day)?`,
          { reply_markup: planBreakfastKeyboard },
        );
        return;
      }
      case 'shopping_list':
        await sink.reply('No active plan yet. Plan your week first!', { reply_markup: mainMenuKeyboard });
        return;
      case 'weekly_budget':
        await sink.reply('No active plan yet.', { reply_markup: mainMenuKeyboard });
        return;
    }
  }

  // ─── Paginated recipe list ─────────────────────────────────────────────
  async function showRecipeList(sink: OutputSink): Promise<void> {
    const all = recipes.getAll();
    const pageSize = 5;
    await sink.reply(`Your recipes (${all.length}):`, {
      reply_markup: recipeListKeyboard(all, session.recipeListPage, pageSize),
    });
  }

  // ─── Free-form text / voice routing ────────────────────────────────────
  async function handleTextInput(text: string, sink: OutputSink): Promise<void> {
    // If in plan flow, route there first
    if (session.planFlow) {
      if (session.planFlow.phase === 'awaiting_events') {
        const stopTyping = sink.startTyping();
        try {
          const result = await handleEventText(session.planFlow, text, llm);
          session.planFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: planMoreEventsKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (session.planFlow.phase === 'awaiting_recipe_prefs') {
        await sink.reply('Generating recipe...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handleGapRecipePrefs(session.planFlow, text, llm);
          session.planFlow = result.state;
          stopTyping();
          const kb = session.planFlow.phase === 'reviewing_recipe'
            ? planGapRecipeReviewKeyboard
            : planProposalKeyboard;
          await sink.reply(result.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (session.planFlow.phase === 'awaiting_swap') {
        const stopTyping = sink.startTyping();
        try {
          const result = await handleSwapText(session.planFlow, text, llm, recipes, store);
          session.planFlow = result.state;
          stopTyping();
          const kb = session.planFlow.phase === 'recipe_suggestion'
            ? planRecipeGapKeyboard(session.planFlow.activeGapIndex ?? 0)
            : planProposalKeyboard;
          await sink.reply(result.text, { reply_markup: kb });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (session.planFlow.phase === 'reviewing_recipe') {
        // User is typing a refinement for the gap recipe
        await sink.reply('Refining recipe...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handleGapRecipeRefinement(session.planFlow, text, llm);
          session.planFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: planGapRecipeReviewKeyboard });
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
    if (session.recipeFlow) {
      if (session.recipeFlow.phase === 'awaiting_preferences') {
        await sink.reply('Generating your recipe — this usually takes a minute or two...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handlePreferencesAndGenerate(session.recipeFlow, text, llm);
          session.recipeFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: recipeReviewKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (session.recipeFlow.phase === 'awaiting_refinement') {
        await sink.reply('Refining your recipe...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handleRefinement(session.recipeFlow, text, llm);
          session.recipeFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: recipeReviewKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      if (session.recipeFlow.phase === 'reviewing') {
        // Classify intent: is this a question or a refinement request?
        const stopTyping = sink.startTyping();
        const intent = await classifyReviewIntent(text, llm);
        log.debug('FLOW', `review intent: ${intent}`);

        if (intent === 'question') {
          try {
            const result = await handleRecipeQuestion(session.recipeFlow, text, llm);
            session.recipeFlow = result.state;
            stopTyping();
            await sink.reply(result.text);
          } catch (err) {
            stopTyping();
            throw err;
          }
          return;
        }

        // It's a refinement — generate updated recipe
        stopTyping();
        await sink.reply('Refining your recipe...');
        const stopTyping2 = sink.startTyping();
        try {
          const result = await handleRefinement(session.recipeFlow, text, llm);
          session.recipeFlow = result.state;
          stopTyping2();
          await sink.reply(result.text, { reply_markup: recipeReviewKeyboard });
        } catch (err) {
          stopTyping2();
          throw err;
        }
        return;
      }
    }

    // Not in a flow — check if they want to view a specific recipe
    const recipe = recipes
      .getAll()
      .find(
        (r) =>
          r.name.toLowerCase().includes(text.toLowerCase()) ||
          r.slug.includes(text.toLowerCase()),
      );
    if (recipe) {
      log.debug('FLOW', `recipe lookup: "${text}" → ${recipe.slug}`);
      await sink.reply(renderRecipe(recipe));
      return;
    }

    await sink.reply('Use the menu buttons below to get started.', { reply_markup: mainMenuKeyboard });
  }

  // ─── Reset (for harness scenarios) ─────────────────────────────────────
  function reset(): void {
    session.recipeFlow = null;
    session.planFlow = null;
    session.recipeListPage = 0;
  }

  return { session, dispatch, reset };
}

// ─── Pure helpers (no deps on BotCore state) ─────────────────────────────────

/**
 * Map a main-menu reply-keyboard button label to its logical action.
 * The main menu is a reply keyboard, so taps arrive as plain text — we route
 * them to the menu handler by matching the label verbatim.
 */
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
 *
 * Uses `new Date()` which is frozen by the harness clock utility during
 * scenario replay so the computed week is stable across runs.
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
