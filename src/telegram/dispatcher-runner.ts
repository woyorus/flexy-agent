/**
 * Dispatcher runner — the integration layer between the pure dispatcher LLM
 * agent (`src/agents/dispatcher.ts`) and the telegram core (`src/telegram/core.ts`).
 *
 * Plan 028 (Plan C from proposal 003-freeform-conversation-layer.md). The runner
 * owns everything that touches `BotCoreSession`: context assembly, action
 * handler dispatch, recent-turns bookkeeping, and the numeric pre-filter for
 * the progress measurement fast path. The pure agent module has no knowledge
 * of session state — it takes a context bundle in and returns a decision out.
 * Keeping the two layers separate means the agent is unit-testable against
 * plain objects and the runner is unit-testable against a fake LLM.
 *
 * This file grows across Task 2 (this file's initial shape), Task 8 (context
 * assembly + action handlers), and Task 10 (return_to_flow re-render helper).
 */

import { config } from '../config.js';
import { log } from '../debug/logger.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import type { Recipe } from '../models/types.js';
import {
  getPlanLifecycle,
  getVisiblePlanSession,
  toLocalISODate,
} from '../plan/helpers.js';
import {
  parseMeasurementInput,
  assignWeightWaist,
  formatDisambiguationPrompt,
} from '../agents/progress-flow.js';
import { formatMeasurementConfirmation } from './formatters.js';
import {
  dispatchMessage,
  DispatcherFailure,
  AVAILABLE_ACTIONS_V0_0_5,
  type DispatcherContext,
  type DispatcherDecision,
  type DispatcherRecipeRow,
  type DispatcherPlanSummary,
  type DispatcherTurn,
  type ActiveFlowSummary,
} from '../agents/dispatcher.js';
import {
  progressDisambiguationKeyboard,
  progressReportKeyboard,
} from './keyboards.js';

/**
 * Structural OutputSink — mirrors `BotCore`'s OutputSink interface. Declared
 * locally to avoid a circular import (core.ts imports from this module).
 * TypeScript's structural typing makes this compatible with the real
 * OutputSink at call sites.
 */
export interface DispatcherOutputSink {
  reply(
    text: string,
    options?: {
      reply_markup?: import('grammy').Keyboard | import('grammy').InlineKeyboard;
      parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    },
  ): Promise<void>;
  answerCallback(): Promise<void>;
  startTyping(): () => void;
}

/**
 * Structural slice of `BotCoreSession` that the runner reads and mutates.
 * Declared here to avoid a circular import with `core.ts`. The real
 * `BotCoreSession` conforms structurally at call sites.
 */
export interface DispatcherSession {
  recipeFlow: { phase: string } | null;
  planFlow:
    | {
        phase: string;
        weekStart?: string;
        horizonStart?: string;
        weekDays?: string[];
        horizonDays?: string[];
        pendingClarification?: { question: string; originalMessage: string };
      }
    | null;
  progressFlow: {
    phase: 'awaiting_measurement' | 'confirming_disambiguation';
    pendingWeight?: number;
    pendingWaist?: number;
    pendingDate?: string;
  } | null;
  surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
  lastRenderedView?: {
    surface: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress';
    view: string;
    [key: string]: unknown;
  };
  recentTurns?: ConversationTurn[];
  pendingMutation?: import('../plan/mutate-plan-applier.js').PendingMutation;
  pendingPostConfirmationClarification?: {
    question: string;
    originalRequest: string;
    createdAt: string;
  };
}

/**
 * A single conversation exchange. Written into `session.recentTurns` by the
 * runner around each dispatcher call, and read back by the runner when it
 * builds the next context bundle.
 *
 * - `role: 'user'` — the inbound message the dispatcher is about to classify
 *   OR just classified.
 * - `role: 'bot'` — the LAST reply the bot produced for this turn. Captured
 *   by `wrapSinkForBotTurnCapture` (Task 8) so it covers ALL action branches
 *   uniformly: dispatcher-authored replies (`clarify`, `out_of_scope`),
 *   re-rendered views (`return_to_flow`), AND downstream flow-handler
 *   replies (`flow_input` → re-proposer output, recipe-flow refinements,
 *   etc.). The proposal 003 context-hydration contract (line 257) calls
 *   for "last 3–5 user/bot exchanges"; recording bot turns from every
 *   branch is what makes that contract real for multi-turn threads like
 *   "what about the lamb?" right after a re-proposer reply that mentioned
 *   lamb.
 *
 *   The wrapper buffers each `sink.reply` and **overwrites** the previous
 *   capture, then commits the most recent one via `flushBotTurn` from a
 *   `try/finally` in the runner. This is what handles the recipe-flow
 *   pattern of `sink.reply('Generating your recipe...')` followed by the
 *   actual rendered recipe — a "first reply wins" policy would record the
 *   holding message and miss the substance, breaking referential threads.
 *
 *   Bot-turn text is truncated to `BOT_TURN_TEXT_MAX` chars at capture
 *   time (before `pushTurn`) so a long MarkdownV2 recipe body doesn't
 *   bloat the in-memory ring buffer or the next dispatcher prompt. The
 *   head of the reply is enough to resolve referential threads — the
 *   dispatcher already has full flow state via `planFlow`/`recipeFlow`
 *   summaries for anything it needs beyond the head.
 *
 * `at` is an ISO timestamp stamped when the turn is pushed; used for debug
 * logging and for expiring very-old turns if that becomes necessary later.
 */
export interface ConversationTurn {
  role: 'user' | 'bot';
  text: string;
  at: string;
}

/**
 * Ring-buffer cap for `session.recentTurns`. The dispatcher's context bundle
 * includes the last `RECENT_TURNS_MAX` turns verbatim. 6 = three user+bot
 * pairs, which the proposal document calls out as "last 3–5 user/bot
 * exchanges". At mini-tier prices, 6 short turns is a trivial prompt-size
 * contribution (~200 tokens) and buys enough context to follow referential
 * threads.
 */
export const RECENT_TURNS_MAX = 6;

/**
 * Truncation cap for bot-turn text captured by `wrapSinkForBotTurnCapture`
 * (Task 8). A long MarkdownV2 recipe body or a full plan proposal can be
 * several thousand characters; storing the full text in the in-memory ring
 * buffer is wasteful and inflates the next dispatcher prompt. 500 chars is
 * enough for the head of a reply to anchor referential threads — the
 * dispatcher already has `planFlow`/`recipeFlow` summaries for anything it
 * needs beyond the head. Truncation is applied at capture time, before
 * `pushTurn`, so the ring buffer never holds oversized entries.
 */
export const BOT_TURN_TEXT_MAX = 500;

/**
 * Append a turn to `session.recentTurns` in place, keeping at most
 * `RECENT_TURNS_MAX` items. The oldest turn is dropped when the buffer is
 * full.
 *
 * Mutates the session. Intentionally not pure so the runner can call it
 * without having to thread the array around.
 *
 * @param session - Any object carrying an optional
 *                  `recentTurns?: ConversationTurn[]` field. The helper
 *                  initializes the field to `[]` on first write, so callers
 *                  never have to check for undefined. Structurally typed so
 *                  unit tests can pass plain objects.
 * @param role - 'user' or 'bot' — see `ConversationTurn` doc.
 * @param text - Exact message body. Long messages are NOT truncated here;
 *               the context-bundle builder applies its own truncation when
 *               it serializes for the LLM prompt (Task 8).
 */
export function pushTurn(
  session: { recentTurns?: ConversationTurn[] },
  role: 'user' | 'bot',
  text: string,
): void {
  if (!session.recentTurns) {
    session.recentTurns = [];
  }
  session.recentTurns.push({
    role,
    text,
    at: new Date().toISOString(),
  });
  while (session.recentTurns.length > RECENT_TURNS_MAX) {
    session.recentTurns.shift();
  }
}

// ─── Context assembly ────────────────────────────────────────────────────────

/**
 * Assemble the per-call context bundle for the dispatcher. Pure — reads
 * session/store/recipes and returns a fresh object. Does NOT call the LLM,
 * does NOT mutate anything. Safe to call repeatedly.
 *
 * The shape of the returned context is defined in `src/agents/dispatcher.ts`
 * and the prompt is built from it in `buildUserPrompt`. Adding or removing
 * a field here is a load-bearing change — make sure the prompt consumes it.
 */
export async function buildDispatcherContext(
  session: DispatcherSession,
  store: StateStoreLike,
  recipes: RecipeDatabase,
  now: Date,
): Promise<DispatcherContext> {
  const today = toLocalISODate(now);
  // `getPlanLifecycle` expects a real BotCoreSession; at runtime the
  // DispatcherSession always IS a BotCoreSession. The cast is structural.
  const lifecycle = await getPlanLifecycle(session as never, store, today);

  // Plan summary — null when there's no visible plan.
  let planSummary: DispatcherPlanSummary | null = null;
  const planSession = await getVisiblePlanSession(store, today);
  if (planSession) {
    const allBatches = await store.getBatchesByPlanSessionId(planSession.id);
    const plannedBatches = allBatches.filter((b) => b.status === 'planned');

    const batchLines = plannedBatches.map((b) => {
      const recipe = recipes.getBySlug(b.recipeSlug);
      const name = recipe?.shortName ?? recipe?.name ?? b.recipeSlug;
      const days = b.eatingDays.join('/');
      return `${b.recipeSlug} (${name}), ${b.servings} servings, ${days} ${b.mealType}`;
    });
    const flexLines = planSession.flexSlots.map(
      (f) => `${f.day} ${f.mealTime} (+${f.flexBonus} kcal flex${f.note ? ' — ' + f.note : ''})`,
    );
    const eventLines = planSession.events.map(
      (e) => `${e.day} ${e.mealTime}: ${e.name} (~${e.estimatedCalories} kcal)`,
    );

    planSummary = {
      horizonStart: planSession.horizonStart,
      horizonEnd: planSession.horizonEnd,
      batchLines,
      flexLines,
      eventLines,
      weeklyCalorieTarget: config.targets.weekly.calories,
      weeklyProteinTarget: config.targets.weekly.protein,
    };
  }

  // Recipe index — one compact row per recipe.
  const recipeIndex: DispatcherRecipeRow[] = recipes.getAll().map((r: Recipe) => ({
    slug: r.slug,
    name: r.shortName ?? r.name,
    cuisine: r.cuisine,
    mealTypes: r.mealTypes,
    fridgeDays: r.storage.fridgeDays,
    freezable: r.storage.freezable,
    reheat: r.storage.reheat,
    calories: r.perServing.calories,
    protein: r.perServing.protein,
  }));

  // Active flow summary.
  const activeFlow: ActiveFlowSummary = buildActiveFlowSummary(session);

  // Recent turns (convert ConversationTurn → DispatcherTurn by dropping the
  // timestamp). Optional field — absent on sessions that never invoked the
  // dispatcher yet.
  const recentTurns: DispatcherTurn[] = (session.recentTurns ?? []).map((t) => ({
    role: t.role,
    text: t.text,
  }));

  return {
    today,
    now: now.toISOString(),
    surface: session.surfaceContext,
    ...(session.lastRenderedView && { lastRenderedView: session.lastRenderedView }),
    lifecycle,
    activeFlow,
    recentTurns,
    planSummary,
    recipeIndex,
    allowedActions: AVAILABLE_ACTIONS_V0_0_5,
    ...(session.pendingPostConfirmationClarification && {
      pendingPostConfirmationClarification: {
        question: session.pendingPostConfirmationClarification.question,
        originalRequest: session.pendingPostConfirmationClarification.originalRequest,
      },
    }),
  };
}

/**
 * Collapse `planFlow` / `recipeFlow` / `progressFlow` into the
 * `ActiveFlowSummary` shape the dispatcher prompt consumes. Preference
 * order when multiple flows are alive: progress > recipe > plan
 * (matches the order `routeTextToActiveFlow` checks today).
 */
function buildActiveFlowSummary(session: DispatcherSession): ActiveFlowSummary {
  if (session.progressFlow) {
    return { kind: 'progress', phase: session.progressFlow.phase };
  }
  if (session.recipeFlow) {
    const phase = session.recipeFlow.phase;
    if (
      phase === 'awaiting_preferences' ||
      phase === 'awaiting_refinement' ||
      phase === 'reviewing'
    ) {
      return { kind: 'recipe', phase };
    }
    return { kind: 'recipe', phase: 'other' };
  }
  if (session.planFlow) {
    const pf = session.planFlow;
    const weekDays = pf.weekDays ?? pf.horizonDays;
    return {
      kind: 'plan',
      phase: pf.phase as
        | 'context'
        | 'awaiting_events'
        | 'generating_proposal'
        | 'proposal'
        | 'confirmed',
      ...(pf.weekStart !== undefined || pf.horizonStart !== undefined
        ? { horizonStart: pf.weekStart ?? pf.horizonStart }
        : {}),
      ...(weekDays && weekDays.length > 0
        ? { horizonEnd: weekDays[weekDays.length - 1] }
        : {}),
      ...(pf.pendingClarification && { pendingClarification: pf.pendingClarification }),
    };
  }
  return { kind: 'none' };
}

// ─── Numeric measurement pre-filter ──────────────────────────────────────────

/**
 * Narrow pre-filter for the progress measurement fast path.
 *
 * Returns `true` if the text was handled inline (the measurement was logged
 * or a disambiguation prompt was sent) AND the caller should NOT invoke the
 * dispatcher. Returns `false` if the text should be dispatched normally.
 *
 * The guard conditions are:
 *   1. `session.progressFlow?.phase === 'awaiting_measurement'`
 *   2. `parseMeasurementInput(text)` returns a non-null result
 *
 * If either fails, we return `false` and the runner invokes the dispatcher.
 */
export async function tryNumericPreFilter(
  text: string,
  session: DispatcherSession,
  store: StateStoreLike,
  sink: DispatcherOutputSink,
): Promise<boolean> {
  if (!session.progressFlow || session.progressFlow.phase !== 'awaiting_measurement') {
    return false;
  }
  const parsed = parseMeasurementInput(text);
  if (!parsed) {
    return false;
  }

  const today = toLocalISODate(new Date());

  if (parsed.values.length === 1) {
    const weight = parsed.values[0]!;
    const isFirst = (await store.getLatestMeasurement('default')) === null;
    await store.logMeasurement('default', today, weight, null);
    session.progressFlow = null;
    let confirmText = formatMeasurementConfirmation(weight, null);
    if (isFirst) {
      confirmText +=
        "\n\nWe track weekly averages, not daily -- so don't worry about day-to-day swings. Come back tomorrow -- we'll start tracking your trend.";
    }
    const reportKb = await getProgressReportKeyboardIfAvailable(store, today);
    if (reportKb) {
      await sink.reply(confirmText, { reply_markup: reportKb });
    } else {
      await sink.reply(confirmText);
    }
    return true;
  }

  // Two numbers — may need disambiguation.
  const [a, b] = parsed.values as [number, number];
  const lastMeasurement = await store.getLatestMeasurement('default');
  const assignment = assignWeightWaist(a, b, lastMeasurement);

  if (!assignment.ambiguous) {
    const isFirst = lastMeasurement === null;
    await store.logMeasurement('default', today, assignment.weight, assignment.waist);
    session.progressFlow = null;
    let confirmText = formatMeasurementConfirmation(assignment.weight, assignment.waist);
    if (isFirst) {
      confirmText +=
        "\n\nWe track weekly averages, not daily -- so don't worry about day-to-day swings. Come back tomorrow -- we'll start tracking your trend.";
    }
    const reportKb = await getProgressReportKeyboardIfAvailable(store, today);
    if (reportKb) {
      await sink.reply(confirmText, { reply_markup: reportKb });
    } else {
      await sink.reply(confirmText);
    }
    return true;
  }

  // Ambiguous — enter disambiguation phase.
  session.progressFlow = {
    phase: 'confirming_disambiguation',
    pendingWeight: assignment.weight,
    pendingWaist: assignment.waist,
    pendingDate: today,
  };
  await sink.reply(formatDisambiguationPrompt(assignment.weight, assignment.waist), {
    reply_markup: progressDisambiguationKeyboard,
  });
  return true;
}

/**
 * Helper ported from core.ts to avoid a circular import. Returns the
 * weekly-report keyboard if last week has enough data to render one.
 */
async function getProgressReportKeyboardIfAvailable(
  store: StateStoreLike,
  today: string,
): Promise<typeof progressReportKeyboard | undefined> {
  const { getCalendarWeekBoundaries } = await import('../utils/dates.js');
  const { lastWeekStart, lastWeekEnd } = getCalendarWeekBoundaries(today);
  const lastWeekData = await store.getMeasurements('default', lastWeekStart, lastWeekEnd);
  return lastWeekData.length > 0 ? progressReportKeyboard : undefined;
}

// ─── Bot-turn capture wrapper ────────────────────────────────────────────────

/**
 * Symbol used to attach the flush function as a non-enumerable property
 * on the wrapped sink. The runner pulls it back off the sink in a
 * `try/finally` after the dispatch action handler returns, so the buffered
 * bot turn is committed exactly once per dispatcher call.
 */
const FLUSH_BOT_TURN = Symbol('dispatcher.flushBotTurn');

/**
 * Wrap a sink so that the LAST `reply` call on it is captured as a bot
 * turn on `session.recentTurns` when the dispatcher's action handler
 * returns. Multiple calls to `sink.reply` within the same dispatch overwrite
 * the buffered capture; only the most recent reply is committed. The
 * runner triggers the commit by calling `flushBotTurn(wrappedSink)` in a
 * `try/finally` around the action dispatch.
 *
 * "Last-reply" (not "first-reply") because several flow handlers emit a
 * transient holding message before the substantive reply — e.g. the recipe
 * flow's `handlePreferencesAndGenerate` first says "Generating your
 * recipe…" then emits the rendered recipe. A first-reply policy would
 * record the holding message and miss the substance.
 */
export function wrapSinkForBotTurnCapture<TSink extends DispatcherOutputSink>(
  sink: TSink,
  session: { recentTurns?: ConversationTurn[] },
): TSink {
  let lastCapture: string | null = null;

  const wrapped = new Proxy(sink, {
    get(target, prop, receiver) {
      if (prop === 'reply') {
        return async (
          text: string,
          ...rest: unknown[]
        ): Promise<void> => {
          lastCapture =
            text.length > BOT_TURN_TEXT_MAX
              ? text.slice(0, BOT_TURN_TEXT_MAX) + '…'
              : text;
          return await (target as DispatcherOutputSink).reply(
            text,
            ...(rest as [undefined?]),
          );
        };
      }
      if (prop === FLUSH_BOT_TURN) {
        return () => {
          if (lastCapture !== null) {
            pushTurn(session, 'bot', lastCapture);
            lastCapture = null;
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as TSink;

  return wrapped;
}

/**
 * Commit the buffered bot-turn capture from a sink wrapped by
 * `wrapSinkForBotTurnCapture`. Safe to call on a sink that wasn't wrapped
 * (no-op) and safe to call multiple times (the second call is a no-op
 * because the buffer is cleared after the first commit).
 */
export function flushBotTurn(sink: DispatcherOutputSink): void {
  const flush = (sink as unknown as { [FLUSH_BOT_TURN]?: () => void })[
    FLUSH_BOT_TURN
  ];
  if (typeof flush === 'function') {
    flush();
  }
}

// ─── Action handlers ─────────────────────────────────────────────────────────

/**
 * `flow_input` — forward the text to the active flow's existing text
 * handler. The handler is injected by the caller (`core.ts`) so the runner
 * does not import `routeTextToActiveFlow` directly.
 *
 * Defensive check: if no flow is active, this is a dispatcher classification
 * error. Log and fall back to the generic hint — the user gets the same UX
 * as today's fallback path, not a silent drop.
 */
export async function handleFlowInputAction(
  decision: Extract<DispatcherDecision, { action: 'flow_input' }>,
  _deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
  userText: string,
  routeToActiveFlow: (text: string, sink: DispatcherOutputSink) => Promise<void>,
  fallback: (sink: DispatcherOutputSink) => Promise<void>,
): Promise<void> {
  void decision;
  const hasActiveFlow =
    session.planFlow !== null ||
    session.recipeFlow !== null ||
    (session.progressFlow !== null &&
      session.progressFlow.phase === 'confirming_disambiguation');
  if (!hasActiveFlow) {
    log.warn(
      'DISPATCHER',
      'flow_input picked but no active flow — classification error, falling back to hint',
    );
    await fallback(sink);
    return;
  }
  await routeToActiveFlow(userText, sink);
}

/**
 * `clarify` — send the dispatcher-authored question as a reply. Leaves
 * session state unchanged. The user's next message will be dispatched
 * fresh with this question in `recentTurns`.
 *
 * **Proposal 003 state-preservation invariant #3:** when a flow is
 * active, the reply MUST include a `[← Back to X]` inline button
 * pointing back to the flow — satisfied here via
 * `buildSideConversationKeyboard`, which emits `plan_resume` /
 * `recipe_resume` callbacks. When no flow is active, invariant #3 says
 * the back button should point at the main view for the current
 * surface context (plan / recipes / shopping / progress); Plan C's
 * minimal implementation falls back to the main menu reply keyboard
 * instead.
 */
export async function handleClarifyAction(
  decision: Extract<DispatcherDecision, { action: 'clarify' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const kb = await buildSideConversationKeyboard(session, deps.store);
  // `sink` is the wrapped sink from `runDispatcherFrontDoor`. This
  // reply is buffered by `wrapSinkForBotTurnCapture` and committed to
  // `session.recentTurns` after the handler returns via `flushBotTurn`
  // in the runner's `try/finally`.
  await sink.reply(decision.response, { reply_markup: kb });
}

/**
 * `out_of_scope` — send the dispatcher's decline. Same keyboard logic as
 * clarify: inline `[← Back to X]` when a flow is active, main menu
 * reply keyboard otherwise.
 */
export async function handleOutOfScopeAction(
  decision: Extract<DispatcherDecision, { action: 'out_of_scope' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const kb = await buildSideConversationKeyboard(session, deps.store);
  await sink.reply(decision.response, { reply_markup: kb });
}

/**
 * Build the keyboard for a side-conversation reply (clarify / out_of_scope).
 *
 * Proposal 003 state-preservation invariant #3: when a flow is active, the
 * reply includes an inline `[← Back to X]` button pointing back to the
 * flow's last view (so the user can return with a tap as well as via
 * natural language). When no flow is active, the reply uses the
 * lifecycle-aware main menu reply keyboard.
 */
async function buildSideConversationKeyboard(
  session: DispatcherSession,
  store: StateStoreLike,
): Promise<import('grammy').Keyboard | import('grammy').InlineKeyboard> {
  const { InlineKeyboard } = await import('grammy');
  const { buildMainMenuKeyboard } = await import('./keyboards.js');

  if (session.planFlow) {
    return new InlineKeyboard().text('← Back to planning', 'plan_resume');
  }
  if (session.recipeFlow) {
    return new InlineKeyboard().text('← Back to recipe', 'recipe_resume');
  }

  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session as never, store, today);
  return buildMainMenuKeyboard(lifecycle);
}

// ─── return_to_flow handler ──────────────────────────────────────────────────

/**
 * `return_to_flow` — re-render the user's last view.
 *
 * Two branches:
 *   1. Active flow → re-render the flow's last view from flow state.
 *   2. No active flow → re-render `session.lastRenderedView` (Plan 027).
 *
 * If neither branch has anything to show, fall back to the menu with a
 * brief "you're at the menu" message.
 */
export async function handleReturnToFlowAction(
  _decision: Extract<DispatcherDecision, { action: 'return_to_flow' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  // Branch 1: active flow.
  if (session.planFlow) {
    await rerenderPlanFlow(session, sink);
    return;
  }
  if (session.recipeFlow) {
    await rerenderRecipeFlow(session, sink);
    return;
  }

  // Branch 2: no active flow, use lastRenderedView.
  if (session.lastRenderedView) {
    await rerenderLastView(session, deps, sink);
    return;
  }

  // Branch 3: nothing to return to.
  const { buildMainMenuKeyboard } = await import('./keyboards.js');
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session as never, deps.store, today);
  await sink.reply("You're at the menu.", { reply_markup: buildMainMenuKeyboard(lifecycle) });
}

/**
 * Re-render the plan flow's current view by delegating to the leaf
 * `getPlanFlowResumeView` helper from `flow-resume-views.ts` (Task 8b).
 *
 * Fidelity: byte-identical for `proposal` phase (reads stored
 * `proposalText`); phase-canonical prompt for all other phases.
 */
async function rerenderPlanFlow(
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { getPlanFlowResumeView } = await import('./flow-resume-views.js');
  const view = getPlanFlowResumeView(
    session.planFlow as unknown as import('../agents/plan-flow.js').PlanFlowState,
  );
  await sink.reply(view.text, {
    ...(view.replyMarkup && { reply_markup: view.replyMarkup }),
    ...(view.parseMode && { parse_mode: view.parseMode }),
  });
}

/**
 * Re-render the recipe flow's current view by delegating to the leaf
 * `getRecipeFlowResumeView` helper from `flow-resume-views.ts` (Task 8b).
 *
 * Fidelity: byte-identical for `reviewing` phase (reads stored
 * `currentRecipe` via `renderRecipe`); phase-canonical prompt for other
 * phases.
 */
async function rerenderRecipeFlow(
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { getRecipeFlowResumeView } = await import('./flow-resume-views.js');
  const view = getRecipeFlowResumeView(
    session.recipeFlow as unknown as import('../agents/recipe-flow.js').RecipeFlowState,
  );
  await sink.reply(view.text, {
    ...(view.replyMarkup && { reply_markup: view.replyMarkup }),
    ...(view.parseMode && { parse_mode: view.parseMode }),
  });
}

/**
 * Re-render the last navigation view the user was looking at. Reads
 * `session.lastRenderedView` (set by Plan 027 handlers) and emits a
 * minimal placeholder reply for each variant — the Tier 3 behavior
 * documented in the Plan 028 decision log.
 *
 * Plan E Task 19 promotes this to full re-render parity with the
 * original callback by delegating to the extracted view-renderers module.
 */
async function rerenderLastView(
  session: DispatcherSession,
  deps: DispatcherRunnerDeps,
  sink: DispatcherOutputSink,
): Promise<void> {
  const view = session.lastRenderedView!;
  const { buildMainMenuKeyboard } = await import('./keyboards.js');
  const today = toLocalISODate(new Date());
  const lifecycle = await getPlanLifecycle(session as never, deps.store, today);
  const menuKb = buildMainMenuKeyboard(lifecycle);

  switch (view.surface) {
    case 'plan':
      await sink.reply('Back to your plan. Tap 📋 My Plan for the current view.', {
        reply_markup: menuKb,
      });
      return;
    case 'cooking':
      await sink.reply('Back to cooking. Tap the cook-day button on your plan to return.', {
        reply_markup: menuKb,
      });
      return;
    case 'shopping':
      await sink.reply('Back to the shopping list. Tap 🛒 Shopping List for the current view.', {
        reply_markup: menuKb,
      });
      return;
    case 'recipes':
      await sink.reply('Back to your recipes. Tap 📖 My Recipes for the full library.', {
        reply_markup: menuKb,
      });
      return;
    case 'progress':
      await sink.reply('Back to progress. Tap 📊 Progress to log or see your report.', {
        reply_markup: menuKb,
      });
      return;
    default:
      log.warn(
        'DISPATCHER',
        `rerenderLastView: unknown surface ${String((view as { surface: string }).surface)}`,
      );
      await sink.reply('Back to the menu.', { reply_markup: menuKb });
  }
}

/**
 * `mutate_plan` — calls the shared applier and routes the result to the sink.
 *
 * Four branches:
 *   - in_session_updated → send text with planProposalKeyboard.
 *   - post_confirmation_proposed → stash `pending` on session, send text
 *     with mutateConfirmKeyboard.
 *   - clarification → send question. Post-confirmation: stash the
 *     clarification for multi-turn resume (invariant #5).
 *   - failure / no_target → send message with the main menu keyboard.
 */
export async function handleMutatePlanAction(
  decision: Extract<DispatcherDecision, { action: 'mutate_plan' }>,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  sink: DispatcherOutputSink,
): Promise<void> {
  const { applyMutationRequest } = await import('../plan/mutate-plan-applier.js');
  const { planProposalKeyboard, mutateConfirmKeyboard } = await import('./keyboards.js');

  let result: import('../plan/mutate-plan-applier.js').MutateResult;
  try {
    result = await applyMutationRequest({
      request: decision.params.request,
      session: session as unknown as { planFlow: import('../agents/plan-flow.js').PlanFlowState | null },
      store: deps.store,
      recipes: deps.recipes,
      llm: deps.llm,
      now: new Date(),
      pendingClarification: session.pendingPostConfirmationClarification
        ? { originalRequest: session.pendingPostConfirmationClarification.originalRequest }
        : undefined,
    });
    // Clear the pending clarification — consumed by this call regardless of outcome.
    session.pendingPostConfirmationClarification = undefined;
  } catch (err) {
    log.error('MUTATE', `applyMutationRequest threw: ${(err as Error).message.slice(0, 200)}`);
    const { buildMainMenuKeyboard } = await import('./keyboards.js');
    const today = toLocalISODate(new Date());
    const lifecycle = await getPlanLifecycle(session as never, deps.store, today);
    await sink.reply(
      "Something went wrong applying that change. Your plan is unchanged. Try rephrasing, or tap a button.",
      { reply_markup: buildMainMenuKeyboard(lifecycle) },
    );
    return;
  }

  switch (result.kind) {
    case 'in_session_updated': {
      await sink.reply(result.text, {
        reply_markup: planProposalKeyboard,
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    case 'post_confirmation_proposed': {
      session.pendingMutation = result.pending;
      await sink.reply(result.text, {
        reply_markup: mutateConfirmKeyboard,
      });
      return;
    }

    case 'clarification': {
      // Post-confirmation clarification — stash for multi-turn resume (invariant #5).
      if (!session.planFlow) {
        session.pendingPostConfirmationClarification = {
          question: result.question,
          originalRequest: decision.params.request,
          createdAt: new Date().toISOString(),
        };
      }
      const kb = await buildSideConversationKeyboard(session, deps.store);
      await sink.reply(result.question, { reply_markup: kb });
      pushTurn(session, 'bot', result.question);
      return;
    }

    case 'failure':
    case 'no_target': {
      const { buildMainMenuKeyboard } = await import('./keyboards.js');
      const today = toLocalISODate(new Date());
      const lifecycle = await getPlanLifecycle(session as never, deps.store, today);
      await sink.reply(result.message, { reply_markup: buildMainMenuKeyboard(lifecycle) });
      pushTurn(session, 'bot', result.message);
      return;
    }
  }
}

// ─── Runner front-door stub (full body lands in Task 11) ─────────────────────

/**
 * Dependencies the runner needs at every call. Matches `BotCoreDeps` from
 * `core.ts` structurally — declared locally here to avoid a circular import.
 */
export interface DispatcherRunnerDeps {
  llm: LLMProvider;
  recipes: RecipeDatabase;
  store: StateStoreLike;
}

/**
 * The front-door entry point. `core.dispatch` calls this for every text /
 * voice inbound after the reply-keyboard menu match has been checked.
 *
 * **Task 8 scaffold:** throws so premature wiring fails loudly. Task 11
 * replaces the body with the full implementation.
 */
export async function runDispatcherFrontDoor(
  text: string,
  deps: DispatcherRunnerDeps,
  session: DispatcherSession,
  rawSink: DispatcherOutputSink,
  routeToActiveFlow: (text: string, sink: DispatcherOutputSink) => Promise<void>,
  fallback: (sink: DispatcherOutputSink) => Promise<void>,
): Promise<void> {
  // ── Numeric pre-filter (narrow bypass for progress measurement) ──
  // Runs BEFORE the bot-turn wrapper because pre-filter replies are not
  // conversational turns — they're flow outputs that the proposer does
  // not need to see again.
  if (await tryNumericPreFilter(text, session, deps.store, rawSink)) {
    return;
  }

  // ── Planning meta-intents fire BEFORE the dispatcher ──
  // Proposal 003 § "Precedence with existing cancel semantics" is load-bearing:
  // cancel phrases must reach the planning cancel handler, not the dispatcher's
  // return_to_flow. Running the existing matcher early short-circuits the
  // dispatcher when a planning flow is active.
  //
  // No `pushTurn` and no bot-turn wrapper around the sink — the cancel
  // short-circuit is a flow termination, not a conversational turn, and
  // scenario 041 asserts `recentTurns` stays absent on the recording.
  if (session.planFlow) {
    const { matchPlanningMetaIntent } = await import('../agents/plan-flow.js');
    const metaIntent = matchPlanningMetaIntent(text);
    if (metaIntent === 'start_over' || metaIntent === 'cancel') {
      await routeToActiveFlow(text, rawSink);
      return;
    }
  }

  // ── Wrap the sink so the LAST bot reply on any branch below lands in
  // `recentTurns` uniformly. ──
  const sink = wrapSinkForBotTurnCapture(rawSink, session);

  // ── Build context bundle ──
  const context = await buildDispatcherContext(session, deps.store, deps.recipes, new Date());

  // ── Push user turn before the LLM call so the dispatcher sees its own
  // message in the recent-turns list (for multi-turn clarify flows). ──
  pushTurn(session, 'user', text);

  // ── Dispatcher call ──
  let decision: DispatcherDecision;
  try {
    decision = await dispatchMessage(context, text, deps.llm);
  } catch (err) {
    if (err instanceof DispatcherFailure) {
      log.error('DISPATCHER', `dispatcher failed; falling back: ${err.message.slice(0, 200)}`);
      try {
        await fallback(sink);
      } finally {
        flushBotTurn(sink);
      }
      return;
    }
    throw err;
  }

  // ── Route the decision to its handler. The `try/finally` guarantees
  // `flushBotTurn` runs even if a downstream handler throws — the most
  // recent `sink.reply` is committed to `recentTurns` so the dispatcher
  // sees the actual bot output (not a holding message that came before
  // it) on the next call. ──
  try {
    switch (decision.action) {
      case 'flow_input':
        await handleFlowInputAction(
          decision,
          deps,
          session,
          sink,
          text,
          routeToActiveFlow,
          fallback,
        );
        return;
      case 'clarify':
        await handleClarifyAction(decision, deps, session, sink);
        return;
      case 'out_of_scope':
        await handleOutOfScopeAction(decision, deps, session, sink);
        return;
      case 'return_to_flow':
        await handleReturnToFlowAction(decision, deps, session, sink);
        return;
      case 'mutate_plan':
        await handleMutatePlanAction(decision, deps, session, sink);
        return;
    }
  } finally {
    flushBotTurn(sink);
  }
}
