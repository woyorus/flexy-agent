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
  sink: DispatcherOutputSink,
  routeToActiveFlow: (text: string, sink: DispatcherOutputSink) => Promise<void>,
  fallback: (sink: DispatcherOutputSink) => Promise<void>,
): Promise<void> {
  void deps;
  void session;
  void sink;
  void routeToActiveFlow;
  void fallback;
  void text;
  // Reference the imports so they survive tree-shaking before Task 11
  // replaces this scaffold with the full body that actually uses them.
  void dispatchMessage;
  void DispatcherFailure;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _decisionRef: DispatcherDecision | null = null;
  void _decisionRef;
  log.debug('DISPATCHER', 'runDispatcherFrontDoor scaffold (Task 8) — handlers land in Task 9');
  throw new Error('runDispatcherFrontDoor is not yet wired (Plan 028 Task 8 scaffold)');
}
