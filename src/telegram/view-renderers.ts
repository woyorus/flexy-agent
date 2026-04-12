/**
 * View renderers — Plan 030.
 *
 * Extracted render helpers that encapsulate the "load data → call formatter
 * → attach keyboard → set lastRenderedView → sink.reply" pattern used by
 * the plan / cook / shopping / recipe / progress views. Today these bodies
 * live inline inside `core.ts`'s callback cases. Plan 030 extracts them so
 * the dispatcher runner's `handleShow*Action` handlers can call the same
 * code path without going through a synthetic callback.
 *
 * ## Architecture position
 *
 * Leaf module — no imports from `core.ts`. `core.ts` imports from this
 * module to delegate from its callback handlers (Plan 030 Task 6 refactor),
 * and `dispatcher-runner.ts` imports from this module to render the view
 * a dispatcher action chose (Tasks 11–17). Neither consumer imports the
 * other, so there is no cycle.
 *
 * The helpers accept a structural `RenderSession` slice rather than
 * `BotCoreSession` directly — this lets `core.ts` pass its full session
 * without the reverse import.
 *
 * ## Contract for every renderer
 *
 *   1. Load whatever plan / recipe / measurement data it needs.
 *   2. Call the formatter (`formatters.ts` or `recipes/renderer.ts`) to produce text.
 *   3. Attach the appropriate keyboard from `keyboards.ts`.
 *   4. Call `setLastRenderedView(session, …)` (Plan 027 invariant).
 *   5. `await sink.reply(text, { reply_markup, parse_mode? })`.
 *
 * ## On "rendered vs. not_in_plan"
 *
 * `renderCookViewForSlug` is the only helper that can fail to find a
 * target. It returns `'rendered' | 'not_in_plan'` so the caller (the
 * `show_recipe` handler) can fall back to the library view. Every other
 * helper returns `void`.
 */

import type { StateStoreLike } from '../state/store.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { LLMProvider } from '../ai/provider.js';
import type {
  Batch,
  BatchView,
  PlanSession,
} from '../models/types.js';
import type { PlanFlowState } from '../agents/plan-flow.js';
import {
  setLastRenderedView,
  type NavigationSessionSlice,
} from './navigation-state.js';
import {
  formatNextAction,
  formatWeekOverview,
  formatDayDetail,
  formatShoppingList,
  formatWeeklyReport,
} from './formatters.js';
import { renderCookView, renderRecipe } from '../recipes/renderer.js';
import {
  buildMainMenuKeyboard,
  cookViewKeyboard,
  recipeViewKeyboard,
  nextActionKeyboard,
  weekOverviewKeyboard,
  dayDetailKeyboard,
  buildShoppingListKeyboard,
  progressReportKeyboard,
  recipeListKeyboard,
} from './keyboards.js';
import {
  generateShoppingList,
  generateShoppingListForWeek,
  generateShoppingListForRecipe,
  generateShoppingListForDay,
  type ShoppingScope,
} from '../shopping/generator.js';
import {
  getVisiblePlanSession,
  getPlanLifecycle,
  getNextCookDay,
  toLocalISODate,
} from '../plan/helpers.js';
import { log } from '../debug/logger.js';

/**
 * Structural session slice the view-renderers require. Matches the subset
 * of `BotCoreSession` each renderer touches. Declared structurally so the
 * module doesn't import `core.ts`.
 */
export interface RenderSession extends NavigationSessionSlice {
  lastRecipeSlug?: string;
  /**
   * Pagination index for the recipe library list view (`renderRecipeLibrary`).
   * Matches `BotCoreSession.recipeListPage`.
   */
  recipeListPage: number;
  planFlow: PlanFlowState | null;
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
    pendingDate?: string;
  } | null;
}

export interface ViewRendererDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStoreLike;
}

export interface ViewOutputSink {
  reply(
    text: string,
    options?: {
      reply_markup?: unknown;
      parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
    },
  ): Promise<void>;
}

export type ViewRenderResult = 'rendered' | 'not_in_plan';

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Load the visible plan + dedupe its batches + resolve recipes.
 * Mirrors `loadPlanBatches` from `core.ts`.
 */
async function loadVisiblePlanAndBatches(
  deps: ViewRendererDeps,
  today: string,
): Promise<{ session: PlanSession; batchViews: BatchView[]; allBatches: Batch[] } | null> {
  const session = await getVisiblePlanSession(deps.store, today);
  if (!session) return null;

  const ownBatches = await deps.store.getBatchesByPlanSessionId(session.id);
  const overlapBatches = await deps.store.getBatchesOverlapping({
    horizonStart: session.horizonStart,
    horizonEnd: session.horizonEnd,
    statuses: ['planned'],
  });
  const seen = new Set<string>();
  const allBatches = [...ownBatches, ...overlapBatches]
    .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)))
    .filter((b) => b.status === 'planned');

  const batchViews: BatchView[] = allBatches.flatMap((b) => {
    const recipe = deps.recipes.getBySlug(b.recipeSlug);
    if (!recipe) {
      log.warn('VIEW', `no recipe for slug ${b.recipeSlug}`);
      return [];
    }
    return [{ batch: b, recipe }];
  });

  return { session, batchViews, allBatches };
}

// ─── Plan view renderers ───────────────────────────────────────────────────

/**
 * Render the Next Action view. Mirrors the `na_show` callback case body.
 */
export async function renderNextAction(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
): Promise<void> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const text = formatNextAction(
    loaded.batchViews,
    loaded.session.events,
    loaded.session.flexSlots,
    today,
    loaded.session.horizonStart,
  );
  const nextCook = getNextCookDay(loaded.allBatches, today);
  const nextCookBatchViews = nextCook
    ? loaded.batchViews.filter(bv => bv.batch.eatingDays[0] === nextCook.date)
    : [];
  const lifecycle = await getPlanLifecycle(session, deps.store, today);
  setLastRenderedView(session, { surface: 'plan', view: 'next_action' });
  await sink.reply(text, { reply_markup: nextActionKeyboard(nextCookBatchViews, lifecycle), parse_mode: 'MarkdownV2' });
}

/**
 * Render the Week Overview. Mirrors the `wo_show` callback case body.
 */
export async function renderWeekOverview(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
): Promise<void> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const breakfastRecipe = deps.recipes.getBySlug(loaded.session.breakfast.recipeSlug);
  const text = formatWeekOverview(
    loaded.session,
    loaded.batchViews,
    loaded.session.events,
    loaded.session.flexSlots,
    breakfastRecipe,
  );
  const weekDays: string[] = [];
  const d = new Date(loaded.session.horizonStart + 'T00:00:00');
  for (let i = 0; i < 7; i++) {
    weekDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  setLastRenderedView(session, { surface: 'plan', view: 'week_overview' });
  await sink.reply(text, { reply_markup: weekOverviewKeyboard(weekDays), parse_mode: 'MarkdownV2' });
}

/**
 * Render a specific day's detail. Mirrors the `dd_<date>` callback case.
 *
 * Guards: rejects invalid date strings and dates outside the visible
 * plan horizon with graceful fallbacks.
 */
export async function renderDayDetail(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  day: string,
): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    await sink.reply("I couldn't figure out which day you meant. Try 'Thursday' or a full date.");
    return;
  }
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  if (day < loaded.session.horizonStart || day > loaded.session.horizonEnd) {
    await sink.reply(
      `${day} isn't in this week's plan (${loaded.session.horizonStart} — ${loaded.session.horizonEnd}).`,
    );
    return;
  }
  const text = formatDayDetail(day, loaded.batchViews, loaded.session.events, loaded.session.flexSlots);
  const cookBatchViews = loaded.batchViews.filter(bv => bv.batch.eatingDays[0] === day);
  setLastRenderedView(session, { surface: 'plan', view: 'day_detail', day });
  await sink.reply(text, { reply_markup: dayDetailKeyboard(day, cookBatchViews, today), parse_mode: 'MarkdownV2' });
}

// ─── Cook view renderers ───────────────────────────────────────────────────

/**
 * Render the cook view for a specific batch ID. Mirrors the `cv_<batchId>`
 * callback case body.
 */
export async function renderCookViewForBatch(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  batchId: string,
): Promise<void> {
  const batch = await deps.store.getBatch(batchId);
  if (!batch) {
    await sink.reply("I couldn't find that batch. It may have been cancelled.");
    return;
  }
  const recipe = deps.recipes.getBySlug(batch.recipeSlug);
  if (!recipe) {
    await sink.reply(`I couldn't find the recipe for ${batch.recipeSlug}.`);
    return;
  }
  const text = renderCookView(recipe, batch);
  setLastRenderedView(session, {
    surface: 'cooking',
    view: 'cook_view',
    batchId: batch.id,
    recipeSlug: batch.recipeSlug,
  });
  session.lastRecipeSlug = batch.recipeSlug;
  await sink.reply(text, {
    reply_markup: cookViewKeyboard(batch.recipeSlug),
    parse_mode: 'MarkdownV2',
  });
}

/**
 * Resolve a recipe slug to the soonest-cook-day batch in the active plan
 * and render its cook view. Returns `'not_in_plan'` if no active batch
 * matches — the caller should fall back to `renderLibraryRecipeView`.
 *
 * **Disambiguation rule (proposal 003 § show_recipe)**: when multiple
 * active batches match the slug, pick the one with the soonest
 * `eatingDays[0]`. Ties are broken by `batchId` lexicographic order for
 * determinism.
 */
export async function renderCookViewForSlug(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  slug: string,
): Promise<ViewRenderResult> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) return 'not_in_plan';

  const matching = loaded.allBatches.filter((b) => b.recipeSlug === slug);
  if (matching.length === 0) return 'not_in_plan';

  matching.sort((a, b) => {
    const aDay = a.eatingDays[0] ?? '';
    const bDay = b.eatingDays[0] ?? '';
    if (aDay !== bDay) return aDay.localeCompare(bDay);
    return a.id.localeCompare(b.id);
  });

  const chosen = matching[0]!;
  await renderCookViewForBatch(session, deps, sink, chosen.id);
  return 'rendered';
}

// ─── Recipe library view renderers ─────────────────────────────────────────

/**
 * Render a library recipe view — per-serving amounts, no batch context.
 * Mirrors the `rv_<slug>` callback case body.
 *
 * Includes the `findBySlugPrefix` fallback for truncated callback-data
 * slugs (Telegram's 64-byte callback limit).
 */
export async function renderLibraryRecipeView(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  slug: string,
): Promise<void> {
  const recipe =
    deps.recipes.getBySlug(slug) ??
    deps.recipes.getAll().find((r) => r.slug.startsWith(slug));
  if (!recipe) {
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply('Recipe not found.', {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const text = renderRecipe(recipe);
  setLastRenderedView(session, { surface: 'recipes', view: 'recipe_detail', slug: recipe.slug });
  session.lastRecipeSlug = recipe.slug;
  await sink.reply(text, {
    reply_markup: recipeViewKeyboard(slug),
    parse_mode: 'MarkdownV2',
  });
}

/**
 * Render the paginated recipe library list with optional "cooking soon"
 * section when the user has an active plan. Mirrors `showRecipeList` from
 * `core.ts`. Reads `session.recipeListPage` directly from the structural
 * slice so `rerenderLastView` can invoke it for the `recipes/library`
 * variant of `LastRenderedView`.
 *
 * Sets `lastRenderedView = { surface: 'recipes', view: 'library' }`.
 */
export async function renderRecipeLibrary(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
): Promise<void> {
  const all = deps.recipes.getAll();
  const pageSize = 5;

  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session, deps.store, today);

  let cookingSoonBatchViews: BatchView[] | undefined;
  if (lifecycle.startsWith('active_') || lifecycle === 'upcoming') {
    const loaded = await loadVisiblePlanAndBatches(deps, today);
    if (loaded) {
      cookingSoonBatchViews = loaded.batchViews
        .filter((bv) => bv.batch.eatingDays.length > 0 && bv.batch.eatingDays[0]! >= today)
        .sort((a, b) => a.batch.eatingDays[0]!.localeCompare(b.batch.eatingDays[0]!));
    }
  }

  const msg =
    cookingSoonBatchViews && cookingSoonBatchViews.length > 0
      ? `COOKING SOON\n\nALL RECIPES (${all.length}):`
      : `Your recipes (${all.length}):`;

  setLastRenderedView(session, { surface: 'recipes', view: 'library' });
  await sink.reply(msg, {
    reply_markup: recipeListKeyboard(all, session.recipeListPage, pageSize, cookingSoonBatchViews),
  });
}

// ─── Shopping list renderer ────────────────────────────────────────────���───

/**
 * Render a shopping list for a given scope. Dispatches to the appropriate
 * generator function (Plan 030 Task 2).
 *
 * Sets `lastRenderedView` with the matching shopping variant.
 */
export async function renderShoppingListForScope(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  scope: ShoppingScope,
): Promise<void> {
  const today = toLocalISODate(new Date());
  const loaded = await loadVisiblePlanAndBatches(deps, today);
  if (!loaded) {
    const lifecycle = await getPlanLifecycle(session, deps.store, today);
    await sink.reply("You don't have a plan yet. Tap 📋 Plan Week to start one.", {
      reply_markup: buildMainMenuKeyboard(lifecycle),
    });
    return;
  }
  const breakfastRecipe = deps.recipes.getBySlug(loaded.session.breakfast.recipeSlug);

  switch (scope.kind) {
    case 'next_cook': {
      const list = generateShoppingList(loaded.allBatches, breakfastRecipe, {
        targetDate: scope.targetDate,
        remainingDays: scope.remainingDays,
      });
      const cookBatchesForDay = loaded.allBatches.filter(b => b.eatingDays[0] === scope.targetDate);
      const scopeParts = cookBatchesForDay.map(b => {
        const recipe = deps.recipes.getBySlug(b.recipeSlug);
        return `${recipe?.name ?? b.recipeSlug} (${b.servings} servings)`;
      });
      if (breakfastRecipe) scopeParts.push('Breakfast');
      const text = formatShoppingList(list, scope.targetDate, scopeParts.join(' + '));
      setLastRenderedView(session, { surface: 'shopping', view: 'next_cook' });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
    case 'full_week': {
      const list = generateShoppingListForWeek(loaded.allBatches, breakfastRecipe, {
        horizonStart: scope.horizonStart,
        horizonEnd: scope.horizonEnd,
      });
      const text = formatShoppingList(
        list,
        scope.horizonStart,
        `Full week ${scope.horizonStart} — ${scope.horizonEnd}`,
      );
      setLastRenderedView(session, { surface: 'shopping', view: 'full_week' });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
    case 'recipe': {
      const list = generateShoppingListForRecipe(loaded.allBatches, {
        recipeSlug: scope.recipeSlug,
      });
      const recipe = deps.recipes.getBySlug(scope.recipeSlug);
      const labelName = recipe?.name ?? scope.recipeSlug;
      const text = formatShoppingList(list, today, `For ${labelName}`);
      setLastRenderedView(session, {
        surface: 'shopping',
        view: 'recipe',
        recipeSlug: scope.recipeSlug,
      });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
    case 'day': {
      const list = generateShoppingListForDay(loaded.allBatches, breakfastRecipe, {
        day: scope.day,
        remainingDays: scope.remainingDays,
      });
      const text = formatShoppingList(list, scope.day, `Day ${scope.day}`);
      setLastRenderedView(session, { surface: 'shopping', view: 'day', day: scope.day });
      await sink.reply(text, { reply_markup: buildShoppingListKeyboard(), parse_mode: 'MarkdownV2' });
      return;
    }
  }
}

// ─── Progress view renderer ────────────────────────────────────────────────

/**
 * Render a progress view. `log_prompt` sets the measurement phase and
 * asks for input; `weekly_report` shows last week's report.
 */
export async function renderProgressView(
  session: RenderSession,
  deps: ViewRendererDeps,
  sink: ViewOutputSink,
  view: 'log_prompt' | 'weekly_report',
): Promise<void> {
  const today = toLocalISODate(new Date());
  const existing = await deps.store.getTodayMeasurement('default', today);

  if (view === 'weekly_report') {
    const { lastWeekStart, lastWeekEnd, prevWeekStart, prevWeekEnd } =
      getWeekBoundariesForReport(today);
    const lastWeek = await deps.store.getMeasurements('default', lastWeekStart, lastWeekEnd);
    const prevWeek = await deps.store.getMeasurements('default', prevWeekStart, prevWeekEnd);
    if (lastWeek.length === 0) {
      await sink.reply("No measurements from last week yet — log one today to start the report.");
      setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
      return;
    }
    const report = formatWeeklyReport(lastWeek, prevWeek, lastWeekStart, lastWeekEnd);
    setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
    await sink.reply(report, { parse_mode: 'Markdown' });
    return;
  }

  // view === 'log_prompt'
  if (existing) {
    session.progressFlow = null;
    const { lastWeekStart, lastWeekEnd } = getWeekBoundariesForReport(today);
    const lastWeek = await deps.store.getMeasurements('default', lastWeekStart, lastWeekEnd);
    const hasCompletedWeekReport = lastWeek.length > 0;
    setLastRenderedView(session, { surface: 'progress', view: 'weekly_report' });
    if (hasCompletedWeekReport) {
      await sink.reply('Already logged today ✓', { reply_markup: progressReportKeyboard });
    } else {
      await sink.reply('Already logged today ✓');
    }
    return;
  }

  session.progressFlow = { phase: 'awaiting_measurement' };
  const hour = new Date().getHours();
  const timeQualifier = hour >= 14 ? '\n\nIf this is your morning weight, drop it here.' : '';
  const prompt = `Drop your weight (and waist if you track it):\n\nExamples: "82.3 / 91" or just "82.3"${timeQualifier}`;
  setLastRenderedView(session, { surface: 'progress', view: 'log_prompt' });
  await sink.reply(prompt);
}

/**
 * Compute week boundary ISO dates for the weekly report. Mon–Sun weeks.
 */
function getWeekBoundariesForReport(today: string): {
  lastWeekStart: string;
  lastWeekEnd: string;
  prevWeekStart: string;
  prevWeekEnd: string;
} {
  const d = new Date(today + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(d);
  thisMonday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
  const prevMonday = new Date(lastMonday);
  prevMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  const prevSunday = new Date(prevMonday);
  prevSunday.setUTCDate(prevMonday.getUTCDate() + 6);

  const iso = (x: Date): string => x.toISOString().slice(0, 10);
  return {
    lastWeekStart: iso(lastMonday),
    lastWeekEnd: iso(lastSunday),
    prevWeekStart: iso(prevMonday),
    prevWeekEnd: iso(prevSunday),
  };
}
