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
 *     The harness sink never writes to `data/logs/debug.log`.
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
  buildMainMenuKeyboard,
  mealTypeKeyboard,
  recipeReviewKeyboard,
  recipeListKeyboard,
  recipeViewKeyboard,
  planReplanKeyboard,
  planBreakfastKeyboard,
  planEventsKeyboard,
  planMoreEventsKeyboard,
  planProposalKeyboard,
  planConfirmedKeyboard,
  postConfirmationKeyboard,
  nextActionKeyboard,
  weekOverviewKeyboard,
  dayDetailKeyboard,
  cookViewKeyboard,
  buildShoppingListKeyboard,
  progressDisambiguationKeyboard,
  progressReportKeyboard,
} from './keyboards.js';
import { setLastRenderedView, type LastRenderedView } from './navigation-state.js';
import { getPlanLifecycle, getVisiblePlanSession, toLocalISODate, getNextCookDay } from '../plan/helpers.js';
import type { PlanLifecycle } from '../plan/helpers.js';
import { getCalendarWeekBoundaries } from '../utils/dates.js';
import { parseMeasurementInput, assignWeightWaist, formatDisambiguationPrompt } from '../agents/progress-flow.js';
import {
  formatMeasurementConfirmation,
  formatWeeklyReport,
  formatNextAction,
  formatWeekOverview,
  formatDayDetail,
  formatPostConfirmation,
  formatShoppingList,
} from './formatters.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { Recipe, BatchView } from '../models/types.js';
import type { StateStoreLike } from '../state/store.js';
import { renderRecipe, renderCookView } from '../recipes/renderer.js';
import { generateShoppingList } from '../shopping/generator.js';
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
  createPlanFlowStateFromHorizon,
  computeNextHorizonStart,
  handleNoEvents,
  handleAddEvent,
  handleEventText,
  handleEventsDone,
  handleGenerateProposal,
  handleApprove,
  handleMutationText,
  matchPlanningMetaIntent,
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
  reply(text: string, options?: { reply_markup?: Keyboard | InlineKeyboard; parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML' }): Promise<void>;
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
  /** D27: pending replan confirmation — set when Plan Week detects a future session */
  pendingReplan?: { replacingSession: import('../models/types.js').PlanSession };
  /** Which screen the user is currently looking at. Used by free-text fallback and back-button nav. */
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  /** Slug of the last recipe viewed — for contextual back navigation. */
  lastRecipeSlug?: string;
  /**
   * Plan 027: Precise "what the user is looking at" — discriminated union
   * that captures the exact render target (plan subview, cook view, shopping
   * scope, recipe detail vs. library, progress subview) plus its parameters
   * (day, batchId, slug, etc.). The dispatcher in Plan C reads this to
   * compute dynamic back-button targets; set via `setLastRenderedView`
   * immediately before every render's `sink.reply`. Stays `undefined` on
   * session init and after `reset()`.
   */
  lastRenderedView?: LastRenderedView;
  /** Progress measurement flow — explicit phase prevents input hijacking after logging. */
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
    /** ISO date when the user entered the numbers — store at parse time so midnight-crossing doesn't shift the log date. */
    pendingDate?: string;
  } | null;
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
    surfaceContext: null,
    progressFlow: null,
  };

  // ─── Lifecycle-aware menu keyboard ─────────────────────────────────────
  /**
   * Build the main menu keyboard with lifecycle-aware labels.
   * Calls getPlanLifecycle() which hits the store (single-row lookup).
   */
  async function getMenuKeyboard(): Promise<import('grammy').Keyboard> {
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, store, today);
    return buildMainMenuKeyboard(lifecycle);
  }

  // ─── Lifecycle-aware free-text fallback ─────────────────────────────────
  /**
   * Reply with a contextual hint when the user types text that doesn't match
   * any active flow or recipe name. Three branches:
   * 1. Recipe on screen (surfaceContext + lastRecipeSlug)
   * 2. No plan for the current week
   * 3. All other states (active plan, planning in progress)
   */
  async function replyFreeTextFallback(sink: OutputSink): Promise<void> {
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, store, today);
    const menu = buildMainMenuKeyboard(lifecycle);

    if ((session.surfaceContext === 'cooking' || session.surfaceContext === 'recipes') && session.lastRecipeSlug) {
      await sink.reply(
        "I can help with this recipe or your plan. Try: 'can I freeze this?' or tap a button.",
        { reply_markup: menu },
      );
      return;
    }

    if (lifecycle === 'no_plan') {
      await sink.reply(
        'I can help you plan your week, browse recipes, or log measurements. Tap Plan Week to get started.',
        { reply_markup: menu },
      );
    } else {
      await sink.reply(
        "I can help with your plan, recipes, shopping, or measurements. Try: 'change Thursday dinner' or tap a button.",
        { reply_markup: menu },
      );
    }
  }

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
      session.planFlow = null;
      session.progressFlow = null;
      session.pendingReplan = undefined;
      session.surfaceContext = null;
      session.lastRecipeSlug = undefined;
      session.lastRenderedView = undefined;
      await sink.reply('Welcome to Flexie. Use the menu below to get started.', {
        reply_markup: await getMenuKeyboard(),
      });
      return;
    }
    if (command === 'cancel') {
      session.recipeFlow = null;
      session.planFlow = null;
      session.progressFlow = null;
      session.pendingReplan = undefined;
      session.lastRenderedView = undefined;
      await sink.reply('Cancelled.', { reply_markup: await getMenuKeyboard() });
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
        await sink.reply(result.text, { reply_markup: await getMenuKeyboard() });
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
      await sink.reply('Discarded.', { reply_markup: await getMenuKeyboard() });
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
        session.surfaceContext = 'recipes';
        session.lastRecipeSlug = recipe.slug;
        log.debug('FLOW', `recipe view: ${slug}`);
        await sink.reply(renderRecipe(recipe), { reply_markup: recipeViewKeyboard(slug), parse_mode: 'MarkdownV2' });
      } else {
        await sink.reply('Recipe not found.', { reply_markup: await getMenuKeyboard() });
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
        await sink.reply('Recipe not found.', { reply_markup: await getMenuKeyboard() });
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
        await sink.reply('Recipe not found.', { reply_markup: await getMenuKeyboard() });
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

    // Post-plan-confirmation actions (legacy keyboard)
    if (action === 'view_shopping_list') {
      session.planFlow = null;
      // Route to sl_next which handles both active and upcoming plans
      await handleCallback('sl_next', sink);
      return;
    }
    if (action === 'view_plan_recipes') {
      session.planFlow = null;
      session.surfaceContext = 'recipes';
      session.lastRecipeSlug = undefined;
      session.recipeListPage = 0;
      await showRecipeList(sink);
      return;
    }

    // ─── Replan confirmation callbacks (D27) ──────────────────────────
    if (action === 'plan_replan_confirm') {
      const pending = session.pendingReplan;
      if (!pending) {
        await sink.reply('No pending replan. Tap Plan Week again.', { reply_markup: await getMenuKeyboard() });
        return;
      }
      session.pendingReplan = undefined;
      await doStartPlanFlow(
        { start: pending.replacingSession.horizonStart, replacingSession: pending.replacingSession },
        pending.replacingSession,
        sink,
      );
      return;
    }

    if (action === 'plan_replan_cancel') {
      session.pendingReplan = undefined;
      await sink.reply('Plan kept.', { reply_markup: await getMenuKeyboard() });
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
          await sink.reply(proposal.text, { reply_markup: planProposalKeyboard });
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
          await sink.reply(proposal.text, { reply_markup: planProposalKeyboard });
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
          // Plan is persisted — clear the in-progress flow state.
          // getPlanLifecycle() will now return active_* based on the persisted session.
          session.planFlow = null;
          stopTyping();

          // Build a rich post-confirmation message if post-confirm data is available
          if (result.postConfirmData) {
            const { firstCookDay, cookBatches } = result.postConfirmData;
            const weekStart = result.state.weekStart;
            const weekEnd = result.state.weekDays[6]!;
            // Resolve batch slugs to BatchViews
            const cookBatchViews: BatchView[] = cookBatches.flatMap(b => {
              const recipe = recipes.getBySlug(b.recipeSlug);
              if (!recipe) { log.warn('CORE', `no recipe for slug ${b.recipeSlug}`); return []; }
              return [{ batch: b, recipe }];
            });
            const text = formatPostConfirmation(weekStart, weekEnd, firstCookDay, cookBatchViews);
            await sink.reply(text, { reply_markup: postConfirmationKeyboard(), parse_mode: 'MarkdownV2' });
          } else {
            await sink.reply(result.text, { reply_markup: planConfirmedKeyboard });
          }
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      // plan_swap callback removed in Plan 025 — users type adjustments directly.

      if (action === 'plan_cancel') {
        session.planFlow = null;
        await sink.reply('Planning cancelled.', { reply_markup: await getMenuKeyboard() });
        return;
      }

      // Gap resolution callbacks removed in Plan 025 — replaced by re-proposer agent.
    }

    // ─── Progress callbacks ──────────────────────────────────────────────
    if (action === 'pg_disambig_yes' || action === 'pg_disambig_no') {
      if (
        session.progressFlow?.phase !== 'confirming_disambiguation' ||
        session.progressFlow.pendingWeight == null ||
        session.progressFlow.pendingWaist == null ||
        session.progressFlow.pendingDate == null
      ) {
        session.progressFlow = null;
        await sink.reply('That measurement confirmation expired. Tap Progress to log again.');
        return;
      }

      let weight = session.progressFlow.pendingWeight;
      let waist = session.progressFlow.pendingWaist;
      if (action === 'pg_disambig_no') {
        [weight, waist] = [waist, weight];
      }

      const pendingDate = session.progressFlow.pendingDate;
      const isFirst = (await store.getLatestMeasurement('default')) === null;
      await store.logMeasurement('default', pendingDate, weight, waist);
      session.progressFlow = null;

      let confirmText = formatMeasurementConfirmation(weight, waist);
      if (isFirst) {
        confirmText += '\n\nWe track weekly averages, not daily -- so don\'t worry about day-to-day swings. Come back tomorrow -- we\'ll start tracking your trend.';
      }
      const reportKb = await getProgressReportKeyboardIfAvailable();
      if (reportKb) {
        await sink.reply(confirmText, { reply_markup: reportKb });
      } else {
        await sink.reply(confirmText);
      }
      return;
    }

    if (action === 'pg_last_report') {
      const today = toLocalISODate(new Date());
      const { lastWeekStart, lastWeekEnd, prevWeekStart, prevWeekEnd } = getCalendarWeekBoundaries(today);
      const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);

      if (lastWeekData.length === 0) {
        await sink.reply('Not enough data for a report yet -- keep logging and your first report will be ready Sunday.');
        return;
      }

      const prevWeekData = await store.getMeasurements('default', prevWeekStart, prevWeekEnd);
      const report = formatWeeklyReport(lastWeekData, prevWeekData, lastWeekStart, lastWeekEnd);
      await sink.reply(report, { parse_mode: 'Markdown' });
      return;
    }

    // ─── Plan view callbacks (Phase 3) ─────────────────────────────────
    if (action === 'na_show' || action === 'wo_show' || action.startsWith('dd_')) {
      const today = toLocalISODate(new Date());
      const lifecycle = await getPlanLifecycle(session, store, today);
      const planSession = await getVisiblePlanSession(store, today);
      if (!planSession) {
        await sink.reply('No active plan.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }

      const { batchViews, allBatches } = await loadPlanBatches(planSession, recipes);
      session.surfaceContext = 'plan';

      if (action === 'na_show') {
        const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
        const nextCook = getNextCookDay(allBatches, today);
        const nextCookBatchViews = nextCook
          ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
          : [];
        await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
        return;
      }

      if (action === 'wo_show') {
        const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
        const text = formatWeekOverview(planSession, batchViews, planSession.events, planSession.flexSlots, breakfastRecipe);
        // Build 7-day array from horizon
        const weekDays: string[] = [];
        const d = new Date(planSession.horizonStart + 'T00:00:00');
        for (let i = 0; i < 7; i++) {
          weekDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
          d.setDate(d.getDate() + 1);
        }
        await sink.reply(text, { reply_markup: weekOverviewKeyboard(weekDays), parse_mode: 'MarkdownV2' });
        return;
      }

      if (action.startsWith('dd_')) {
        const date = action.slice(3);
        // Validate ISO date and within horizon
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < planSession.horizonStart || date > planSession.horizonEnd) {
          await sink.reply('Invalid or expired date.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
          return;
        }
        const text = formatDayDetail(date, batchViews, planSession.events, planSession.flexSlots);
        const cookBatchViews = batchViews.filter(bv => bv.batch.eatingDays[0] === date);
        await sink.reply(text, { reply_markup: dayDetailKeyboard(date, cookBatchViews, today), parse_mode: 'MarkdownV2' });
        return;
      }
    }

    // ─── Cook view callback (Phase 4) ─────────────────────────────────
    if (action.startsWith('cv_')) {
      const batchId = action.slice(3);
      const batch = await store.getBatch(batchId);
      if (!batch) {
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply('Batch not found.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }
      const recipe = recipes.getBySlug(batch.recipeSlug);
      if (!recipe) {
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        await sink.reply('Recipe not found.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }
      session.surfaceContext = 'cooking';
      session.lastRecipeSlug = batch.recipeSlug;
      await sink.reply(
        renderCookView(recipe, batch),
        { reply_markup: cookViewKeyboard(batch.recipeSlug), parse_mode: 'MarkdownV2' },
      );
      return;
    }

    // ─── Shopping list callbacks (Phase 5) ─────────────────────────────
    if (action.startsWith('sl_')) {
      const param = action.slice(3); // "next" or ISO date
      const today = toLocalISODate(new Date());
      const lifecycle = await getPlanLifecycle(session, store, today);
      const planSession = await getVisiblePlanSession(store, today);
      if (!planSession) {
        await sink.reply('No plan for this week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }

      const { allBatches } = await loadPlanBatches(planSession, recipes);
      const plannedBatches = allBatches.filter(b => b.status === 'planned');

      let targetDate: string;
      if (param === 'next') {
        const nextCook = getNextCookDay(plannedBatches, today);
        if (!nextCook) {
          await sink.reply('All meals are prepped — no shopping needed\\!', { parse_mode: 'MarkdownV2' });
          return;
        }
        targetDate = nextCook.date;
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(param) || param < today || param < planSession.horizonStart || param > planSession.horizonEnd) {
          await sink.reply('This shopping list is from a different plan week.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
          return;
        }
        targetDate = param;
      }

      const cookBatchesForDay = plannedBatches.filter(b => b.eatingDays[0] === targetDate);
      if (cookBatchesForDay.length === 0 && param !== 'next') {
        await sink.reply('No cooking scheduled for that day.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
        return;
      }

      const breakfastRecipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
      if (!breakfastRecipe) {
        log.warn('CORE', `breakfast recipe not found: ${planSession.breakfast.recipeSlug}`);
      }

      // Compute remaining days inclusive
      const horizonEnd = new Date(planSession.horizonEnd + 'T12:00:00');
      const target = new Date(targetDate + 'T12:00:00');
      const remainingDays = Math.round((horizonEnd.getTime() - target.getTime()) / 86400000) + 1;

      const list = generateShoppingList(plannedBatches, breakfastRecipe ?? undefined, {
        targetDate,
        remainingDays,
      });

      // Build scope description
      const scopeParts = cookBatchesForDay.map(b => {
        const recipe = recipes.getBySlug(b.recipeSlug);
        return `${recipe?.name ?? b.recipeSlug} (${b.servings} servings)`;
      });
      if (breakfastRecipe) scopeParts.push('Breakfast');

      session.surfaceContext = 'shopping';
      await sink.reply(
        formatShoppingList(list, targetDate, scopeParts.join(' + ')),
        { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' },
      );
      return;
    }
  }

  // ─── Main-menu reply-button handling ───────────────────────────────────

  /** Start the planning flow with resolved horizon + breakfast. Shared by plan_week and plan_replan_confirm. */
  async function doStartPlanFlow(
    horizon: { start: string; replacingSession?: import('../models/types.js').PlanSession },
    replacingSession: import('../models/types.js').PlanSession | undefined,
    sink: OutputSink,
  ): Promise<void> {
    const breakfastRecipes = recipes.getByMealType('breakfast');
    let breakfastSource: { recipeSlug: string; caloriesPerDay: number; proteinPerDay: number } | undefined;

    if (replacingSession) {
      breakfastSource = replacingSession.breakfast;
    } else {
      const running = await store.getRunningPlanSession(toLocalISODate(new Date()));
      const fallbackSession = running ?? (await store.getLatestHistoricalPlanSession(toLocalISODate(new Date())));
      if (fallbackSession) {
        breakfastSource = fallbackSession.breakfast;
      }
    }

    const breakfast = breakfastSource
      ? {
          recipeSlug: breakfastSource.recipeSlug,
          name: recipes.getBySlug(breakfastSource.recipeSlug)?.name ?? 'Your breakfast',
          caloriesPerDay: breakfastSource.caloriesPerDay,
          proteinPerDay: breakfastSource.proteinPerDay,
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

    session.planFlow = createPlanFlowStateFromHorizon(
      horizon.start,
      breakfast,
      replacingSession?.id,
    );
    log.debug('FLOW', `plan week started: ${horizon.start}, breakfast: ${breakfast.name}${replacingSession ? `, replacing session ${replacingSession.id}` : ''}`);

    const weekEnd = session.planFlow.weekDays[6]!;
    const startStr = formatDateForMessage(horizon.start);
    const endStr = formatDateForMessage(weekEnd);

    await sink.reply(
      `Planning ${startStr} – ${endStr}.\n\nBreakfast: keep ${breakfast.name} (${breakfast.caloriesPerDay} cal/day)?`,
      { reply_markup: planBreakfastKeyboard },
    );
  }

  /**
   * Build a resume view for an in-progress planning flow.
   * Shows the user where they left off and re-displays the appropriate keyboard.
   */
  function getPlanFlowResumeView(state: PlanFlowState): {
    text: string;
    replyMarkup?: InlineKeyboard | Keyboard;
    parseMode?: 'MarkdownV2';
  } {
    switch (state.phase) {
      case 'context': {
        const weekEnd = state.weekDays[6]!;
        return {
          text: `Planning ${formatDateForMessage(state.weekStart)} – ${formatDateForMessage(weekEnd)}. Breakfast: keep ${state.breakfast.name}?`,
          replyMarkup: planBreakfastKeyboard,
        };
      }
      case 'awaiting_events': {
        const kb = state.events.length === 0 ? planEventsKeyboard : planMoreEventsKeyboard;
        return {
          text: "You're adding events for the week. Send another event or tap Done.",
          replyMarkup: kb,
        };
      }
      case 'generating_proposal':
        return { text: 'Still working on it…' };
      case 'proposal':
        return {
          text: state.proposalText ?? 'Your plan is ready for review.',
          replyMarkup: planProposalKeyboard,
        };
      case 'confirmed':
        // Should not reach here (handled by lifecycle guard)
        return { text: 'Plan already confirmed.' };
    }
  }

  async function handleMenu(action: string, sink: OutputSink): Promise<void> {
    session.recipeFlow = null; // exit any recipe flow
    session.progressFlow = null; // exit any progress flow
    // planFlow is NOT cleared here. It persists until the user
    // explicitly confirms the plan or cancels via /cancel.

    switch (action) {
      case 'my_plan': {
        // "📋 My Plan" tapped with active or upcoming plan → show Next Action view
        session.surfaceContext = 'plan';
        session.lastRecipeSlug = undefined;
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        const planSession = await getVisiblePlanSession(store, today);
        if (planSession && (lifecycle.startsWith('active_') || lifecycle === 'upcoming')) {
          const { batchViews, allBatches } = await loadPlanBatches(planSession, recipes);
          const text = formatNextAction(batchViews, planSession.events, planSession.flexSlots, today, planSession.horizonStart);
          const nextCook = getNextCookDay(allBatches, today);
          const nextCookBatchViews = nextCook
            ? batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
            : [];
          await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
          return;
        }
        // Fallback: no plan at all — treat as plan_week
        await handleMenu('plan_week', sink);
        return;
      }
      case 'my_recipes': {
        session.surfaceContext = 'recipes';
        session.lastRecipeSlug = undefined;
        const all = recipes.getAll();
        if (all.length === 0) {
          session.recipeFlow = createRecipeFlowState();
          await sink.reply("No recipes yet. Let's create your first one.\n\nWhat type?", {
            reply_markup: mealTypeKeyboard,
          });
        } else {
          session.recipeListPage = 0;
          await showRecipeList(sink);
        }
        return;
      }
      case 'plan_week': {
        session.surfaceContext = 'plan';
        session.lastRecipeSlug = undefined;
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);

        // Planning in progress → resume where they left off
        if (lifecycle === 'planning' && session.planFlow) {
          const resumeView = getPlanFlowResumeView(session.planFlow);
          await sink.reply(resumeView.text, {
            ...(resumeView.replyMarkup && { reply_markup: resumeView.replyMarkup }),
            ...(resumeView.parseMode && { parse_mode: resumeView.parseMode }),
          });
          return;
        }

        // Active plan + "📋 Plan Week" text → fall through to computeNextHorizonStart.
        // "📋 My Plan" text routes to 'my_plan' case above which shows Next Action.

        // no_plan → check recipe gate, then start new plan
        const lunchDinnerRecipes = recipes
          .getAll()
          .filter((r) => r.mealTypes.includes('lunch') || r.mealTypes.includes('dinner'));
        if (lunchDinnerRecipes.length === 0) {
          await sink.reply(
            'You need some lunch/dinner recipes first. Add a few, then come back to plan your week.',
            { reply_markup: await getMenuKeyboard() },
          );
          return;
        }

        // Plan 007: compute horizon start using rolling-horizon logic
        const horizon = await computeNextHorizonStart(store);

        // D27: if a future-only session exists, prompt for confirmation before replanning
        if (horizon.replacingSession) {
          const rStart = formatDateForMessage(horizon.replacingSession.horizonStart);
          const rEnd = formatDateForMessage(horizon.replacingSession.horizonEnd);
          session.pendingReplan = { replacingSession: horizon.replacingSession };
          await sink.reply(
            `You already have a plan for ${rStart} – ${rEnd}. Replan it?`,
            { reply_markup: planReplanKeyboard },
          );
          return;
        }

        // Normal flow: no future session to replace
        await doStartPlanFlow(horizon, undefined, sink);
        return;
      }
      case 'shopping_list': {
        session.surfaceContext = 'shopping';
        session.lastRecipeSlug = undefined;
        // If user was mid-planning for a future week, abandon that draft —
        // they explicitly asked for the shopping list, which needs the current plan.
        if (session.planFlow) {
          session.planFlow = null;
        }
        const today = toLocalISODate(new Date());
        const lifecycle = await getPlanLifecycle(session, store, today);
        if (lifecycle === 'no_plan') {
          await sink.reply('No plan yet — plan your week first to see what you\'ll need.', { reply_markup: buildMainMenuKeyboard(lifecycle) });
          return;
        }
        // Active or upcoming plan → delegate to sl_next handler by dispatching a callback
        await handleCallback('sl_next', sink);
        return;
      }
      case 'progress': {
        session.surfaceContext = 'progress';
        session.lastRecipeSlug = undefined;

        const today = toLocalISODate(new Date());
        const existing = await store.getTodayMeasurement('default', today);

        if (existing) {
          session.progressFlow = null;
          const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
          const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
          const hasCompletedWeekReport = lastWeekData.length > 0;
          const alreadyText = 'Already logged today ✓';
          if (hasCompletedWeekReport) {
            await sink.reply(alreadyText, { reply_markup: progressReportKeyboard });
          } else {
            await sink.reply(alreadyText);
          }
          return;
        }

        // No measurement today — prompt for input
        session.progressFlow = { phase: 'awaiting_measurement' };
        const hour = new Date().getHours();
        const timeQualifier = hour >= 14
          ? '\n\nIf this is your morning weight, drop it here.'
          : '';
        const prompt = `Drop your weight (and waist if you track it):\n\nExamples: "82.3 / 91" or just "82.3"${timeQualifier}`;
        await sink.reply(prompt);
        return;
      }
      // Legacy alias — old persistent keyboards may still show "Weekly Budget"
      case 'weekly_budget':
        // Fall through to the same handler as 'progress' by re-dispatching
        await handleMenu('progress', sink);
        return;
    }
  }

  // ─── Plan data loading helper ─────────────────────────────────────────
  /**
   * Load all batches for a plan session, deduplicated, with recipe resolution.
   * Combines own batches + carry-over overlapping batches.
   */
  async function loadPlanBatches(planSession: import('../models/types.js').PlanSession, recipeDb: RecipeDatabase): Promise<{
    batchViews: BatchView[];
    allBatches: import('../models/types.js').Batch[];
  }> {
    const ownBatches = await store.getBatchesByPlanSessionId(planSession.id);
    const overlapBatches = await store.getBatchesOverlapping({
      horizonStart: planSession.horizonStart,
      horizonEnd: planSession.horizonEnd,
      statuses: ['planned'],
    });
    // Deduplicate by id
    const seen = new Set<string>();
    const allBatches = [...ownBatches, ...overlapBatches]
      .filter(b => seen.has(b.id) ? false : (seen.add(b.id), true))
      .filter(b => b.status === 'planned');

    const batchViews: BatchView[] = allBatches.flatMap(b => {
      const recipe = recipeDb.getBySlug(b.recipeSlug);
      if (!recipe) { log.warn('CORE', `no recipe for slug ${b.recipeSlug}`); return []; }
      return [{ batch: b, recipe }];
    });

    return { batchViews, allBatches };
  }

  // ─── Paginated recipe list ─────────────────────────────────────────────
  async function showRecipeList(sink: OutputSink): Promise<void> {
    const all = recipes.getAll();
    const pageSize = 5;

    // Check if there's an active plan with upcoming cook batches
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, store, today);
    let cookingSoonBatchViews: BatchView[] | undefined;

    if (lifecycle.startsWith('active_') || lifecycle === 'upcoming') {
      const planSession = await getVisiblePlanSession(store, today);
      if (planSession) {
        const { batchViews } = await loadPlanBatches(planSession, recipes);
        cookingSoonBatchViews = batchViews
          .filter(bv => bv.batch.eatingDays.length > 0 && bv.batch.eatingDays[0]! >= today)
          .sort((a, b) => a.batch.eatingDays[0]!.localeCompare(b.batch.eatingDays[0]!));
      }
    }

    // Build the message text with section headers
    let msg: string;
    if (cookingSoonBatchViews && cookingSoonBatchViews.length > 0) {
      msg = `COOKING SOON\n\nALL RECIPES (${all.length}):`;
    } else {
      msg = `Your recipes (${all.length}):`;
    }

    await sink.reply(msg, {
      reply_markup: recipeListKeyboard(all, session.recipeListPage, pageSize, cookingSoonBatchViews),
    });
  }

  // ─── Free-form text / voice routing ────────────────────────────────────
  /** Check if a completed prior week has data and return the inline keyboard if so. */
  async function getProgressReportKeyboardIfAvailable(): Promise<typeof progressReportKeyboard | undefined> {
    const today = toLocalISODate(new Date());
    const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
    const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
    return lastWeekData.length > 0 ? progressReportKeyboard : undefined;
  }

  async function handleTextInput(text: string, sink: OutputSink): Promise<void> {
    // Progress flow — measurement input
    if (session.progressFlow) {
      if (session.progressFlow.phase === 'awaiting_measurement') {
        const parsed = parseMeasurementInput(text);
        if (!parsed) {
          await sink.reply('I\'m expecting a number like 82.3 or 82.3 / 91');
          return;
        }

        const today = toLocalISODate(new Date());

        if (parsed.values.length === 1) {
          // Single number — weight only
          const weight = parsed.values[0];
          const isFirst = (await store.getLatestMeasurement('default')) === null;
          await store.logMeasurement('default', today, weight, null);
          session.progressFlow = null;
          let confirmText = formatMeasurementConfirmation(weight, null);
          if (isFirst) {
            confirmText += '\n\nWe track weekly averages, not daily -- so don\'t worry about day-to-day swings. Come back tomorrow -- we\'ll start tracking your trend.';
          }
          const reportKb = await getProgressReportKeyboardIfAvailable();
          if (reportKb) {
            await sink.reply(confirmText, { reply_markup: reportKb });
          } else {
            await sink.reply(confirmText);
          }
          return;
        }

        // Two numbers — may need disambiguation
        const [a, b] = parsed.values;
        const lastMeasurement = await store.getLatestMeasurement('default');
        const assignment = assignWeightWaist(a, b, lastMeasurement);

        if (!assignment.ambiguous) {
          // Unambiguous — log immediately
          const isFirst = lastMeasurement === null;
          await store.logMeasurement('default', today, assignment.weight, assignment.waist);
          session.progressFlow = null;
          let confirmText = formatMeasurementConfirmation(assignment.weight, assignment.waist);
          if (isFirst) {
            confirmText += '\n\nWe track weekly averages, not daily -- so don\'t worry about day-to-day swings. Come back tomorrow -- we\'ll start tracking your trend.';
          }
          const reportKb = await getProgressReportKeyboardIfAvailable();
          if (reportKb) {
            await sink.reply(confirmText, { reply_markup: reportKb });
          } else {
            await sink.reply(confirmText);
          }
          return;
        }

        // Ambiguous — ask for confirmation
        session.progressFlow = {
          phase: 'confirming_disambiguation',
          pendingWeight: assignment.weight,
          pendingWaist: assignment.waist,
          pendingDate: today,
        };
        await sink.reply(
          formatDisambiguationPrompt(assignment.weight, assignment.waist),
          { reply_markup: progressDisambiguationKeyboard },
        );
        return;
      }

      if (session.progressFlow.phase === 'confirming_disambiguation') {
        await sink.reply('Use the buttons above to confirm.');
        return;
      }
    }

    // Recipe flow checked first: when both planFlow and recipeFlow are active
    // (user started recipe creation during a planning side trip), text must
    // reach recipeFlow. planFlow's non-text phases would silently swallow it.
    if (session.recipeFlow) {
      if (session.recipeFlow.phase === 'awaiting_preferences') {
        await sink.reply('Generating your recipe — this usually takes a minute or two...');
        const stopTyping = sink.startTyping();
        try {
          const result = await handlePreferencesAndGenerate(session.recipeFlow, text, llm);
          session.recipeFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: recipeReviewKeyboard, ...(result.parseMode && { parse_mode: result.parseMode }) });
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
          await sink.reply(result.text, { reply_markup: recipeReviewKeyboard, ...(result.parseMode && { parse_mode: result.parseMode }) });
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
          await sink.reply(result.text, { reply_markup: recipeReviewKeyboard, ...(result.parseMode && { parse_mode: result.parseMode }) });
        } catch (err) {
          stopTyping2();
          throw err;
        }
        return;
      }
    }

    // If in plan flow, route there
    if (session.planFlow) {
      // ── Meta intents: "start over" / "cancel" — work from any phase ──
      const metaIntent = matchPlanningMetaIntent(text);
      if (metaIntent === 'start_over') {
        // Reset flow and restart planning from scratch with same horizon
        const horizon = await computeNextHorizonStart(store);
        session.planFlow = null;
        await doStartPlanFlow(
          horizon,
          horizon.replacingSession,
          sink,
        );
        return;
      }
      if (metaIntent === 'cancel') {
        session.planFlow = null;
        session.surfaceContext = null;
        await sink.reply('Planning cancelled.', { reply_markup: await getMenuKeyboard() });
        return;
      }

      // ── Phase-specific text handlers ──
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

      if (session.planFlow.phase === 'proposal') {
        // Plan 025: all mutation text goes through the re-proposer agent.
        const stopTyping = sink.startTyping();
        try {
          const result = await handleMutationText(session.planFlow, text, llm, recipes);
          session.planFlow = result.state;
          stopTyping();
          await sink.reply(result.text, { reply_markup: planProposalKeyboard });
        } catch (err) {
          stopTyping();
          throw err;
        }
        return;
      }

      // Plan flow active but not awaiting text — show lifecycle-aware hint
      await replyFreeTextFallback(sink);
      return;
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
      await sink.reply(renderRecipe(recipe), { parse_mode: 'MarkdownV2' });
      return;
    }

    await replyFreeTextFallback(sink);
  }

  // ─── Reset (for harness scenarios) ─────────────────────────────────────
  function reset(): void {
    session.recipeFlow = null;
    session.planFlow = null;
    session.progressFlow = null;
    session.recipeListPage = 0;
    session.surfaceContext = null;
    session.lastRecipeSlug = undefined;
    session.lastRenderedView = undefined;
    session.pendingReplan = undefined;
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
    '📋 Resume Plan': 'plan_week',
    '📋 My Plan': 'my_plan',
    '🛒 Shopping List': 'shopping_list',
    '📖 My Recipes': 'my_recipes',
    '📊 Progress': 'progress',
    '📊 Weekly Budget': 'weekly_budget', // fallback alias during transition
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
