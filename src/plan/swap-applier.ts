/**
 * Emergency ingredient swap applier — Plan 033 / design doc 006.
 *
 * Owns target resolution, the auto-apply / ask-first / help-me-pick /
 * clarification / hard_no policy, persistence via `store.updateBatch` (or
 * `store.updatePlanSessionBreakfast` for breakfast targets), post-agent
 * guardrail validation, and the rendered cook-view (or preview) text.
 *
 * Entry points:
 *   - `applySwapRequest` — the dispatcher's `swap_ingredient` handler
 *     calls this on every routed message. Resolves target, invokes the
 *     agent, maps the agent's decision onto a `SwapResult` the handler
 *     relays to the user.
 *   - `commitPendingSwap` / `commitPendingSwapMulti` — called by
 *     `trySwapPreFilter` when the user confirms a previewed swap (or
 *     picks a candidate / "both" on a multi-batch preview). Pure
 *     persistence + render; no LLM call.
 *
 * The applier does NOT run the dispatcher LLM; it is invoked AFTER the
 * dispatcher has routed and decided `swap_ingredient`. The pre-filter
 * handles bare confirmations and cancellations deterministically before
 * the dispatcher runs.
 */

import type {
  ScaledIngredient,
  MacrosWithFatCarbs,
  SwapChange,
  SwapRecord,
  BreakfastOverride,
  Batch,
  PlanSession,
} from '../models/types.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import type { LLMProvider } from '../ai/provider.js';
import type { TraceEvent } from '../harness/trace.js';
import { decideIngredientSwap, type SwapTarget, type IngredientSwapDecision } from '../agents/ingredient-swap.js';
import { scaleRecipe } from '../agents/recipe-scaler.js';
import { renderCookView, renderBreakfastCookView } from '../recipes/renderer.js';
import { config } from '../config.js';
import { log } from '../debug/logger.js';
import { getVisiblePlanSession, toLocalISODate } from './helpers.js';
import {
  formatMacroDelta,
  formatSwapChange,
  validateSwapAgainstGuardrails,
} from '../utils/swap-format.js';

/** Payload the applier commits (or previews before commit). */
export interface PendingSwapProposed {
  scaledIngredients: ScaledIngredient[];
  /**
   * For a batch target, per-serving macros after the swap.
   * For a breakfast target, per-day macros after the swap.
   */
  actualMacros: MacrosWithFatCarbs;
  nameOverride?: string | null;
  bodyOverride?: string | null;
  changes: SwapChange[];
  /** Pre-computed delta lines, reused on commit so the cook view is stable across preview → apply. */
  deltaLines?: string[];
}

/** See module comment. */
export interface PendingSwapSingle {
  kind: 'single';
  /** Batch ID OR the literal 'breakfast' sentinel. */
  targetId: string;
  /** Verbatim user message that produced the preview. */
  originalRequest: string;
  /** The proposed payload ready to commit on confirm. */
  proposed: PendingSwapProposed;
  reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
  createdAt: string;
}

/** See module comment. */
export interface PendingSwapMultiBatch {
  kind: 'multi_batch';
  originalRequest: string;
  candidates: Array<{
    targetId: string;
    description: string;
    shortName: string;
    mealType: 'lunch' | 'dinner' | 'breakfast';
    proposed: PendingSwapProposed;
  }>;
  previewText: string;
  reason: 'ambiguous_target' | 'hedged' | 'unknown_substitute' | 'structural' | 'stale_view';
  createdAt: string;
}

export type PendingSwap = PendingSwapSingle | PendingSwapMultiBatch;

/** Discriminated result from {@link applySwapRequest}. */
export type SwapResult =
  | { kind: 'applied'; targetId: string; recipeSlug: string; cookViewText: string }
  | {
      kind: 'applied_multi';
      applied: Array<{ targetId: string; recipeSlug: string; cookViewText: string }>;
    }
  | { kind: 'preview'; previewText: string; pending: PendingSwap }
  | { kind: 'help_me_pick'; optionsText: string }
  | { kind: 'clarification'; question: string }
  | {
      kind: 'hard_no';
      message: string;
      routingHint?: 'recipe_level_swap' | 'library_edit' | 'no_target';
    }
  | { kind: 'no_target'; message: string };

export interface ApplySwapRequestArgs {
  request: string;
  targetBatchId?: string;
  session: {
    pendingSwap?: PendingSwap;
    surfaceContext: 'plan' | 'cooking' | 'shopping' | 'recipes' | 'progress' | null;
    lastRenderedView?: import('../telegram/navigation-state.js').LastRenderedView;
  };
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
  now?: Date;
  onTrace?: (event: TraceEvent) => void;
}

/** Verbatim hard-no message for a batch whose every eating day is already in the past. */
const PAST_BATCH_HARD_NO_MESSAGE =
  "That batch is already done — nothing left to cook. " +
  "If the same ingredient is in an upcoming batch and you want to swap it there, " +
  "tell me which one. Or if you want this swap baked into the recipe across " +
  "future weeks, edit the library recipe itself — that's a separate conversation.";

/**
 * Apply a swap request. Resolves the target batch (or the per-session
 * breakfast), invokes the swap agent, persists / previews / surfaces help
 * or clarification based on the agent's decision. Runs the post-agent
 * guardrail validator on apply paths.
 */
export async function applySwapRequest(args: ApplySwapRequestArgs): Promise<SwapResult> {
  const now = args.now ?? new Date();
  const today = toLocalISODate(now);

  // Step 1: rewrite path — clear the prior pendingSwap and carry the
  // targetIdHint forward. The pre-filter has already intercepted bare
  // confirm / cancel / pick; by the time we're here the message is a
  // rewrite or a fresh swap.
  const resolvedBatchId = args.targetBatchId ?? inferTargetFromPending(args.session.pendingSwap);

  // Load the active plan session (needed for breakfast targets and for
  // ingredient-search fallback when no target is provided).
  const planSession = await getVisiblePlanSession(args.store, today);

  // Step 2: breakfast target path.
  if (resolvedBatchId === 'breakfast') {
    if (!planSession) {
      return {
        kind: 'no_target',
        message: "There's no active plan to swap ingredients in — tap 📋 Plan Week first.",
      };
    }
    return decideAndApply({
      args,
      target: await buildBreakfastSwapTarget(planSession, args.recipes, args.store, args.llm),
      planSession,
      now,
      targetIsUnambiguous: args.targetBatchId === 'breakfast',
    });
  }

  // Step 3: explicit batch target.
  if (resolvedBatchId) {
    const batch = await args.store.getBatch(resolvedBatchId);
    if (!batch || batch.status !== 'planned') {
      return {
        kind: 'hard_no',
        message: "That batch isn't available for swaps anymore. Try again from a cook view.",
        routingHint: 'no_target',
      };
    }
    // Past-batch invariant (Phase 8.5).
    if (batch.eatingDays.every((d) => d < today)) {
      args.onTrace?.({ kind: 'swap', op: 'hard_no', targetId: batch.id, reason: 'past_batch' });
      return {
        kind: 'hard_no',
        message: PAST_BATCH_HARD_NO_MESSAGE,
        routingHint: 'library_edit',
      };
    }
    const target = buildBatchSwapTarget(batch, args.recipes);
    if (!target) {
      return {
        kind: 'hard_no',
        message: "I can't find the recipe for that batch.",
        routingHint: 'no_target',
      };
    }
    return decideAndApply({
      args,
      target,
      planSession: planSession ?? null,
      now,
      targetIsUnambiguous: args.targetBatchId !== undefined || isCookViewOnBatch(args.session.lastRenderedView, batch.id),
    });
  }

  // Step 4: no batch id — resolve from active plan + user message.
  if (!planSession) {
    return {
      kind: 'no_target',
      message: "There's no active plan to swap ingredients in — tap 📋 Plan Week first.",
    };
  }
  const candidates = await resolveCandidateBatches(planSession, args);
  if (candidates.length === 0) {
    return {
      kind: 'clarification',
      question:
        "I don't see that ingredient in this week's plan. Which batch did you want to swap it in?",
    };
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    // Plan 033: a SINGLE-candidate match means the user's ingredient
    // mention uniquely binds to one batch (or breakfast). That IS
    // unambiguous — treat it as such so the agent can auto-apply
    // when its other criteria hold (named substitute + non-structural).
    // Passing targetIsUnambiguous=false here was a bug that pushed
    // every ingredient-search-resolved swap into the preview path,
    // even simple wine→stock swaps.
    if (only.kind === 'breakfast') {
      return decideAndApply({
        args,
        target: await buildBreakfastSwapTarget(planSession, args.recipes, args.store, args.llm),
        planSession,
        now,
        targetIsUnambiguous: true,
      });
    }
    const target = buildBatchSwapTarget(only.batch, args.recipes);
    if (!target) {
      return {
        kind: 'hard_no',
        message: "I can't find the recipe for that batch.",
        routingHint: 'no_target',
      };
    }
    if (only.batch.eatingDays.every((d) => d < today)) {
      args.onTrace?.({ kind: 'swap', op: 'hard_no', targetId: only.batch.id, reason: 'past_batch' });
      return {
        kind: 'hard_no',
        message: PAST_BATCH_HARD_NO_MESSAGE,
        routingHint: 'library_edit',
      };
    }
    return decideAndApply({ args, target, planSession, now, targetIsUnambiguous: true });
  }

  // Step 5: multiple candidates — per-candidate agent call in parallel,
  // then pack into a PendingSwapMultiBatch. The pre-filter resolves the
  // user's pick with zero additional LLM calls.
  return decideMultiBatch({ args, candidates, planSession, now });
}

/** Preserve the pending target id so a rewrite doesn't lose the implicit target. */
function inferTargetFromPending(pending?: PendingSwap): string | undefined {
  if (!pending) return undefined;
  if (pending.kind === 'single') return pending.targetId;
  return undefined;
}

function isCookViewOnBatch(view: ApplySwapRequestArgs['session']['lastRenderedView'], batchId: string): boolean {
  if (!view) return false;
  if (view.surface !== 'cooking') return false;
  const viewBatchId = (view as unknown as { batchId?: string }).batchId;
  return viewBatchId === batchId;
}

/** Build a batch-kind SwapTarget from the DB batch + recipe. */
function buildBatchSwapTarget(
  batch: Batch,
  recipes: RecipeDatabase,
): Extract<SwapTarget, { kind: 'batch' }> | null {
  const recipe = recipes.getBySlug(batch.recipeSlug);
  if (!recipe) return null;
  return {
    kind: 'batch',
    targetId: batch.id,
    recipe,
    servings: batch.servings,
    targetMacros: batch.targetPerServing,
    currentMacros: batch.actualPerServing,
    currentIngredients: batch.scaledIngredients,
    currentName: batch.nameOverride ?? recipe.name,
    currentBody: batch.bodyOverride ?? recipe.body,
    swapHistory: batch.swapHistory ?? [],
    eatingDays: batch.eatingDays,
  };
}

/**
 * Build a breakfast-kind SwapTarget. If the session already has a
 * breakfastOverride, read per-day ingredients/macros/body from it;
 * otherwise materialize them by running the scaler once against the
 * library breakfast recipe at `caloriesPerDay` / `proteinPerDay`.
 */
async function buildBreakfastSwapTarget(
  planSession: PlanSession,
  recipes: RecipeDatabase,
  store: StateStoreLike,
  llm: LLMProvider,
): Promise<Extract<SwapTarget, { kind: 'breakfast' }>> {
  const recipe = recipes.getBySlug(planSession.breakfast.recipeSlug);
  if (!recipe) {
    throw new Error(
      `Breakfast swap target unavailable: recipe "${planSession.breakfast.recipeSlug}" missing from library.`,
    );
  }
  const horizonDays = daysBetweenInclusive(planSession.horizonStart, planSession.horizonEnd);

  if (planSession.breakfastOverride) {
    const ov = planSession.breakfastOverride;
    return {
      kind: 'breakfast',
      targetId: 'breakfast',
      recipe,
      targetMacros: {
        calories: planSession.breakfast.caloriesPerDay,
        protein: planSession.breakfast.proteinPerDay,
      },
      currentMacros: ov.actualPerDay,
      currentIngredients: ov.scaledIngredientsPerDay,
      currentName: ov.nameOverride ?? recipe.name,
      currentBody: ov.bodyOverride ?? recipe.body,
      swapHistory: ov.swapHistory,
      horizonDays,
    };
  }

  // Materialize — one scaler call. The result is NOT written back to the
  // session here; only a successful commit writes the override.
  const scaled = await scaleRecipe(
    {
      recipe,
      targetCalories: planSession.breakfast.caloriesPerDay,
      calorieTolerance: config.planning.scalerCalorieTolerance,
      targetProtein: planSession.breakfast.proteinPerDay,
      servings: 1,
    },
    llm,
  );
  // Void the unused var — retained for symmetry with paid operations.
  void store;
  return {
    kind: 'breakfast',
    targetId: 'breakfast',
    recipe,
    targetMacros: {
      calories: planSession.breakfast.caloriesPerDay,
      protein: planSession.breakfast.proteinPerDay,
    },
    currentMacros: scaled.actualPerServing,
    currentIngredients: scaled.scaledIngredients,
    currentName: recipe.name,
    currentBody: recipe.body,
    swapHistory: [],
    horizonDays,
  };
}

function daysBetweenInclusive(start: string, end: string): number {
  const s = new Date(start + 'T00:00:00Z').getTime();
  const e = new Date(end + 'T00:00:00Z').getTime();
  return Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Scan the plan for batches (and the breakfast) whose current ingredient
 * list contains a name mentioned in `args.request`. Returns all matches
 * — the caller decides "zero" / "one" / "many" disambiguation.
 */
async function resolveCandidateBatches(
  planSession: PlanSession,
  args: ApplySwapRequestArgs,
): Promise<Array<{ kind: 'batch'; batch: Batch } | { kind: 'breakfast' }>> {
  const userLower = args.request.toLowerCase();
  const ownBatches = await args.store.getBatchesByPlanSessionId(planSession.id);
  const overlapBatches = await args.store.getBatchesOverlapping({
    horizonStart: planSession.horizonStart,
    horizonEnd: planSession.horizonEnd,
    statuses: ['planned'],
  });
  const seen = new Set<string>();
  const all = [...ownBatches, ...overlapBatches]
    .filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)))
    .filter((b) => b.status === 'planned');

  const matches: Array<{ kind: 'batch'; batch: Batch } | { kind: 'breakfast' }> = [];
  for (const b of all) {
    if (batchMentionsUserIngredient(b, userLower)) matches.push({ kind: 'batch', batch: b });
  }

  // Also scan the breakfast recipe's ingredients (or its override).
  if (breakfastMentionsUserIngredient(planSession, args.recipes, userLower)) {
    matches.push({ kind: 'breakfast' });
  }

  // Plan 033: bare reversal phrases ("undo", "reset to original",
  // "swap back") don't name a specific ingredient — they reference the
  // implicit "last swap" on whatever carries swap history. When we
  // found no ingredient match BUT the message is a bare reversal,
  // return every target that has a non-empty swap_history (batches) or
  // a breakfast override. Single-match cases then route naturally;
  // multi-match cases get the existing multi-batch disambiguation.
  if (matches.length === 0 && isBareReversalPhrase(userLower)) {
    for (const b of all) {
      if ((b.swapHistory ?? []).length > 0) matches.push({ kind: 'batch', batch: b });
    }
    if (planSession.breakfastOverride) {
      matches.push({ kind: 'breakfast' });
    }
  }

  return matches;
}

/**
 * Bare reversal phrases that should bind to any target carrying a prior
 * swap when no ingredient is named explicitly. Kept conservative — only
 * matches when the message is ONLY a reversal phrase (plus optional
 * glue words), so something like "swap back the chicken" still routes
 * through the ingredient-search path.
 */
function isBareReversalPhrase(userLower: string): boolean {
  const trimmed = userLower.trim().replace(/[.!?]$/, '');
  return /^(undo|undo (the )?(last|previous|recent)( one| swap)?|swap back|revert( (it|that|everything))?|reset( to original| to the library recipe| everything| all my swaps)?|undo all( my swaps)?)$/.test(trimmed);
}

function batchMentionsUserIngredient(batch: Batch, userLower: string): boolean {
  // Current ingredients
  for (const ing of batch.scaledIngredients) {
    if (nameAppearsInUser(ing.name, userLower)) return true;
  }
  // Plan 033 reversal support: the user may name an ingredient that was
  // displaced by a prior swap and is no longer in the current batch
  // (e.g., "undo the wine swap" — wine is no longer in scaledIngredients
  // because it was replaced by stock). Scan swap history's `from`
  // fields so reversal targets resolve correctly.
  for (const rec of batch.swapHistory ?? []) {
    for (const c of rec.changes) {
      if (c.kind === 'replace' && nameAppearsInUser(c.from, userLower)) return true;
      if (c.kind === 'remove' && nameAppearsInUser(c.ingredient, userLower)) return true;
    }
  }
  return false;
}

function nameAppearsInUser(name: string, userLower: string): boolean {
  const nameLower = name.toLowerCase();
  if (userLower.includes(nameLower)) return true;
  for (const token of nameLower.split(/\s+/)) {
    if (token.length >= 4 && userLower.includes(token)) return true;
  }
  return false;
}

/**
 * Exported so `test/unit/swap-applier-breakfast-resolver.test.ts` can
 * drive it as a pure function. Not part of the public runtime surface
 * — the export exists strictly for unit-test access (proposal 008
 * Commitment B — every pure-function bug scenarios catch ships a
 * regression unit test with the fix).
 */
export function breakfastMentionsUserIngredient(
  planSession: PlanSession,
  recipes: RecipeDatabase,
  userLower: string,
): boolean {
  const ingredients = planSession.breakfastOverride?.scaledIngredientsPerDay
    ?? recipes.getBySlug(planSession.breakfast.recipeSlug)?.ingredients.map((i) => ({
      name: i.name,
      amount: i.amount,
      unit: i.unit,
      totalForBatch: i.amount,
      role: i.role,
    })) ?? [];
  for (const ing of ingredients) {
    if (nameAppearsInUser(ing.name, userLower)) return true;
  }
  // Plan 033 reversal support (parity with batch targets): the user may
  // name an ingredient that was displaced by a prior breakfast swap and
  // is no longer in scaledIngredientsPerDay ("put the yogurt back" after
  // yogurt → ricotta). Scan the breakfast override's swap_history's
  // `from` fields so reversal targets resolve correctly.
  for (const rec of planSession.breakfastOverride?.swapHistory ?? []) {
    for (const c of rec.changes) {
      if (c.kind === 'replace' && nameAppearsInUser(c.from, userLower)) return true;
      if (c.kind === 'remove' && nameAppearsInUser(c.ingredient, userLower)) return true;
    }
  }
  return false;
}

/**
 * Resolve a SwapTarget, call the agent, commit / preview / surface.
 * Runs the guardrail validator on apply paths; a violating agent response
 * is downgraded to `hard_no` with an honest message.
 */
async function decideAndApply(opts: {
  args: ApplySwapRequestArgs;
  target: SwapTarget;
  planSession: PlanSession | null;
  now: Date;
  targetIsUnambiguous: boolean;
}): Promise<SwapResult> {
  const { args, target, planSession, now, targetIsUnambiguous } = opts;

  const decision = await decideIngredientSwap(
    {
      target,
      userMessage: args.request,
      surface: args.session.surfaceContext,
      targetIsUnambiguous,
      noisePctOfTarget: config.planning.swapNoisePctOfTarget,
    },
    args.llm,
    args.onTrace,
  );

  args.onTrace?.({
    kind: 'swap',
    op: decision.kind,
    targetId: target.targetId,
    ...(decision.kind === 'preview' ? { reason: decision.reason } : {}),
  });

  switch (decision.kind) {
    case 'apply':
      return applyDecision({
        target,
        decision,
        args,
        planSession,
        now,
      });
    case 'preview': {
      // Plan 033: guardrail validation runs on the proposed payload even
      // on the preview path so an injected violation doesn't slip into
      // pendingSwap and later commit silently via the pre-filter.
      const guardrail = validateSwapAgainstGuardrails({
        current: target.currentIngredients,
        proposed: decision.proposed.scaledIngredients,
        userMessage: args.request,
        changes: decision.proposed.changes,
        swapHistory: target.swapHistory,
      });
      if (!guardrail.ok) {
        log.warn('SWAP', `preview guardrail rejected: ${guardrail.reason}`);
        args.onTrace?.({ kind: 'retry', validator: 'swap-guardrail-preview', attempt: 1, errors: [guardrail.reason] });
        args.onTrace?.({ kind: 'swap', op: 'hard_no', targetId: target.targetId, reason: 'guardrail' });
        return {
          kind: 'hard_no',
          message:
            `I can't apply that swap — ${guardrail.reason}. ` +
            `Tell me exactly which ingredients to change and I'll redo it.`,
          routingHint: 'no_target',
        };
      }
      return {
        kind: 'preview',
        previewText: decision.previewText,
        pending: buildSinglePendingFromDecision(target, decision, args.request, now),
      };
    }
    case 'help_me_pick':
      return { kind: 'help_me_pick', optionsText: decision.optionsText };
    case 'clarification':
      return { kind: 'clarification', question: decision.question };
    case 'hard_no':
      return {
        kind: 'hard_no',
        message: decision.message,
        ...(decision.routingHint ? { routingHint: decision.routingHint } : {}),
      };
  }
}

/**
 * Package an apply decision into a PendingSwapSingle. Reused when the
 * applier wants to preview via the same pathway, and when the agent
 * returns kind='preview' directly.
 */
function buildSinglePendingFromDecision(
  target: SwapTarget,
  decision: Extract<IngredientSwapDecision, { kind: 'preview' }>,
  originalRequest: string,
  now: Date,
): PendingSwapSingle {
  return {
    kind: 'single',
    targetId: target.targetId,
    originalRequest,
    proposed: {
      scaledIngredients: decision.proposed.scaledIngredients,
      actualMacros: decision.proposed.actualMacros,
      ...(decision.proposed.nameOverride !== undefined
        ? { nameOverride: decision.proposed.nameOverride }
        : {}),
      ...(decision.proposed.bodyOverride !== undefined
        ? { bodyOverride: decision.proposed.bodyOverride }
        : {}),
      changes: decision.proposed.changes,
    },
    reason: decision.reason,
    createdAt: now.toISOString(),
  };
}

/**
 * Commit an agent apply decision — guardrail check, persist, render the
 * cook view with the delta block.
 */
async function applyDecision(opts: {
  target: SwapTarget;
  decision: Extract<IngredientSwapDecision, { kind: 'apply' }>;
  args: ApplySwapRequestArgs;
  planSession: PlanSession | null;
  now: Date;
}): Promise<SwapResult> {
  const { target, decision, args, planSession, now } = opts;

  // Reset-to-original path (Phase 7) — re-run scaler, clear overrides.
  if (decision.resetToOriginal) {
    return applyResetToOriginal({ target, args, planSession, now });
  }

  // Guardrail validation: reject or soft-warn if the agent mutated a
  // precisely-bought ingredient the user did not name. The agent's
  // changes[] is passed so an ingredient the agent explicitly declares
  // (e.g., `replace from=cottage-cheese to=ricotta` on a rewrite turn)
  // satisfies the diff check without re-naming by the user. The
  // batch's prior swap history is passed so reversal turns ("undo")
  // can restore previously-displaced ingredients without the user
  // having to re-type them.
  const guardrail = validateSwapAgainstGuardrails({
    current: target.currentIngredients,
    proposed: decision.scaledIngredients,
    userMessage: args.request,
    changes: decision.changes,
    swapHistory: target.swapHistory,
  });
  if (!guardrail.ok) {
    log.warn('SWAP', `guardrail rejected swap: ${guardrail.reason}`);
    args.onTrace?.({ kind: 'retry', validator: 'swap-guardrail', attempt: 1, errors: [guardrail.reason] });
    args.onTrace?.({ kind: 'swap', op: 'hard_no', targetId: target.targetId, reason: 'guardrail' });
    return {
      kind: 'hard_no',
      message:
        `I can't apply that swap — ${guardrail.reason}. ` +
        `Tell me exactly which ingredients to change and I'll redo it.`,
      routingHint: 'no_target',
    };
  }

  const deltaLines = pickDeltaLines(decision, target);

  if (target.kind === 'breakfast') {
    if (!planSession) {
      return {
        kind: 'no_target',
        message: "There's no active plan to swap ingredients in.",
      };
    }
    const override = buildBreakfastOverride({
      existing: planSession.breakfastOverride,
      decision,
      now,
      userMessage: args.request,
    });
    const updatedSession = await args.store.updatePlanSessionBreakfast(planSession.id, override);
    args.onTrace?.({ kind: 'persist', op: 'updatePlanSessionBreakfast', argSummary: target.targetId });

    const cookViewText = renderBreakfastCookView(target.recipe, updatedSession, { deltaLines });
    return {
      kind: 'applied',
      targetId: 'breakfast',
      recipeSlug: target.recipe.slug,
      cookViewText,
    };
  }

  // Batch target — persist ingredients + macros + optional overrides +
  // appended swapHistory.
  const appendedHistory: SwapRecord[] = [
    ...target.swapHistory,
    buildSwapRecord({ decision, userMessage: args.request, now }),
  ];
  const updated = await args.store.updateBatch(target.targetId, {
    scaledIngredients: decision.scaledIngredients,
    actualPerServing: decision.actualMacros,
    ...(decision.nameOverride !== undefined ? { nameOverride: decision.nameOverride } : {}),
    ...(decision.bodyOverride !== undefined ? { bodyOverride: decision.bodyOverride } : {}),
    swapHistory: appendedHistory,
  });
  args.onTrace?.({ kind: 'persist', op: 'updateBatch', argSummary: target.targetId });

  const cookViewText = renderCookView(target.recipe, updated, { deltaLines });
  return {
    kind: 'applied',
    targetId: target.targetId,
    recipeSlug: target.recipe.slug,
    cookViewText,
  };
}

/** Build a SwapRecord from the agent's apply decision. */
function buildSwapRecord(opts: {
  decision: Extract<IngredientSwapDecision, { kind: 'apply' }>;
  userMessage: string;
  now: Date;
}): SwapRecord {
  return {
    appliedAt: opts.now.toISOString(),
    userMessage: opts.userMessage,
    changes: opts.decision.changes,
    resultingMacros: opts.decision.actualMacros,
  };
}

/**
 * Build the BreakfastOverride to persist. If an override already exists,
 * preserve and extend `swapHistory`; otherwise start a fresh history.
 */
function buildBreakfastOverride(opts: {
  existing?: BreakfastOverride;
  decision: Extract<IngredientSwapDecision, { kind: 'apply' }>;
  now: Date;
  userMessage: string;
}): BreakfastOverride {
  const { existing, decision, now, userMessage } = opts;
  const record = buildSwapRecord({ decision, userMessage, now });
  const history = existing ? [...existing.swapHistory, record] : [record];
  const base: BreakfastOverride = {
    scaledIngredientsPerDay: decision.scaledIngredients,
    actualPerDay: decision.actualMacros,
    swapHistory: history,
  };
  // nameOverride / bodyOverride: apply the decision when it sets them
  // (string or null); otherwise preserve existing.
  if (decision.nameOverride === null) {
    // cleared — omit from override.
  } else if (typeof decision.nameOverride === 'string') {
    base.nameOverride = decision.nameOverride;
  } else if (existing?.nameOverride) {
    base.nameOverride = existing.nameOverride;
  }
  if (decision.bodyOverride === null) {
    // cleared — omit.
  } else if (typeof decision.bodyOverride === 'string') {
    base.bodyOverride = decision.bodyOverride;
  } else if (existing?.bodyOverride) {
    base.bodyOverride = existing.bodyOverride;
  }
  return base;
}

/**
 * Pick delta lines for the cook-view footer. Prefer the agent's pre-
 * formatted lines when non-empty; otherwise regenerate from `changes` and
 * append a macro-delta line. Adds a shopping-list summary when the swap
 * happened on the shopping surface and touched a precisely-bought
 * ingredient (Phase 5.4).
 */
function pickDeltaLines(
  decision: Extract<IngredientSwapDecision, { kind: 'apply' }>,
  target: SwapTarget,
): string[] {
  // Plan 033: start with the agent's pre-formatted delta lines when
  // available. Defense-in-depth: ensure every declared SwapChange is
  // represented — if the agent emitted the helper in `changes` but
  // forgot to list it in `delta_lines`, regenerate the missing line
  // from the change itself so the user sees every change they should.
  const agentLines = decision.deltaLines && decision.deltaLines.length > 0
    ? [...decision.deltaLines]
    : [];
  const lines = agentLines.length > 0 ? [...agentLines] : decision.changes.map(formatSwapChange);

  for (const change of decision.changes) {
    const mentioned = lines.some((line) => deltaLineMentions(line, change));
    if (!mentioned) {
      lines.push(formatSwapChange(change));
    }
  }

  // Ensure at least one macro line is present.
  const hasMacroLine = lines.some((l) => /^Macros:/i.test(l));
  if (!hasMacroLine) {
    const perUnit = target.kind === 'breakfast' ? 'day' : 'serving';
    lines.push(
      formatMacroDelta({
        beforeCalories: target.currentMacros.calories,
        afterCalories: decision.actualMacros.calories,
        afterProtein: decision.actualMacros.protein,
        targetCalories: target.targetMacros.calories,
        noisePctOfTarget: config.planning.swapNoisePctOfTarget,
        perUnit,
      }),
    );
  }
  return lines;
}

/**
 * Does the rendered delta line text mention the ingredient(s) named in
 * this SwapChange? Used to detect a missing-helper case where the agent
 * listed a change but forgot to add a line for it.
 */
function deltaLineMentions(line: string, change: SwapChange): boolean {
  const lower = line.toLowerCase();
  switch (change.kind) {
    case 'replace':
      return lower.includes(change.from.toLowerCase()) && lower.includes(change.to.toLowerCase());
    case 'remove':
      return lower.includes(change.ingredient.toLowerCase());
    case 'add':
      return lower.includes(change.ingredient.toLowerCase());
    case 'rebalance':
      return lower.includes(change.ingredient.toLowerCase());
    case 'rename':
      return lower.includes(change.to.toLowerCase());
  }
}

/** Reset-to-original: re-scale the library recipe, clear all overrides. */
async function applyResetToOriginal(opts: {
  target: SwapTarget;
  args: ApplySwapRequestArgs;
  planSession: PlanSession | null;
  now: Date;
}): Promise<SwapResult> {
  const { target, args, planSession, now } = opts;
  void now;

  if (target.kind === 'breakfast') {
    if (!planSession) {
      return { kind: 'no_target', message: "There's no active plan." };
    }
    // Plan 033: "reset" on a breakfast target means "return to the
    // library recipe scaled to the session's LOCKED caloriesPerDay /
    // proteinPerDay" — NOT "use the library recipe's raw amounts". The
    // locked target often differs from `recipe.perServing.calories`;
    // simply clearing `breakfastOverride` would leave the renderer and
    // the shopping-list generator to fall back to library defaults and
    // display a mismatch between the header ("cal/day") and the
    // ingredient amounts. Re-scale and persist as a fresh (empty-
    // history) override so the reset survives through all downstream
    // read sites.
    const scaled = await scaleRecipe(
      {
        recipe: target.recipe,
        targetCalories: planSession.breakfast.caloriesPerDay,
        calorieTolerance: config.planning.scalerCalorieTolerance,
        targetProtein: planSession.breakfast.proteinPerDay,
        servings: 1,
      },
      args.llm,
    );
    const resetOverride: BreakfastOverride = {
      scaledIngredientsPerDay: scaled.scaledIngredients,
      actualPerDay: scaled.actualPerServing,
      swapHistory: [],
    };
    const resetSession = await args.store.updatePlanSessionBreakfast(planSession.id, resetOverride);
    args.onTrace?.({ kind: 'persist', op: 'updatePlanSessionBreakfast', argSummary: 'reset' });
    const cookViewText = renderBreakfastCookView(target.recipe, resetSession, {
      deltaLines: ['Reset: returned to library recipe.'],
    });
    return {
      kind: 'applied',
      targetId: 'breakfast',
      recipeSlug: target.recipe.slug,
      cookViewText,
    };
  }

  // Batch target — re-scale against the batch's targetPerServing.
  const scaled = await scaleRecipe(
    {
      recipe: target.recipe,
      targetCalories: target.targetMacros.calories,
      calorieTolerance: config.planning.scalerCalorieTolerance,
      targetProtein: target.targetMacros.protein,
      servings: target.servings,
    },
    args.llm,
  );
  const updated = await args.store.updateBatch(target.targetId, {
    scaledIngredients: scaled.scaledIngredients,
    actualPerServing: scaled.actualPerServing,
    nameOverride: null,
    bodyOverride: null,
    swapHistory: [],
  });
  args.onTrace?.({ kind: 'persist', op: 'updateBatch', argSummary: `${target.targetId}:reset` });
  const cookViewText = renderCookView(target.recipe, updated, {
    deltaLines: ['Reset: returned to library recipe.'],
  });
  return {
    kind: 'applied',
    targetId: target.targetId,
    recipeSlug: target.recipe.slug,
    cookViewText,
  };
}

/**
 * Multi-batch preview: run the agent once per candidate in parallel; pack
 * the decisions into a PendingSwapMultiBatch so commit runs with zero
 * extra LLM calls. Aggregate preview text is a deterministic template.
 */
async function decideMultiBatch(opts: {
  args: ApplySwapRequestArgs;
  candidates: Array<{ kind: 'batch'; batch: Batch } | { kind: 'breakfast' }>;
  planSession: PlanSession;
  now: Date;
}): Promise<SwapResult> {
  const { args, candidates, planSession, now } = opts;
  // Build targets first (some candidates need a scaler call for breakfast
  // materialization; batch targets are synchronous).
  const targets = await Promise.all(
    candidates.map(async (c): Promise<SwapTarget | null> => {
      if (c.kind === 'batch') {
        return buildBatchSwapTarget(c.batch, args.recipes);
      }
      return buildBreakfastSwapTarget(planSession, args.recipes, args.store, args.llm);
    }),
  );
  const usable = targets.filter((t): t is SwapTarget => t !== null);
  if (usable.length === 0) {
    return { kind: 'hard_no', message: "I couldn't resolve any batches for that swap.", routingHint: 'no_target' };
  }

  const decisions = await Promise.all(
    usable.map((t) =>
      decideIngredientSwap(
        {
          target: t,
          userMessage: args.request,
          surface: args.session.surfaceContext,
          targetIsUnambiguous: false,
          noisePctOfTarget: config.planning.swapNoisePctOfTarget,
        },
        args.llm,
        args.onTrace,
      ),
    ),
  );

  // Plan 033: when EVERY candidate is help_me_pick (the user asked "what
  // should I get?" and the shape fits all matching batches), collapse to
  // a single help_me_pick on the first apply/preview-capable candidate or
  // — failing that — on the first candidate's optionsText. Prevents a
  // multi-batch preview fallback from eating the message when the user
  // really just wanted options.
  const allHelpMePick = decisions.every((d) => d.kind === 'help_me_pick');
  if (allHelpMePick) {
    const first = decisions.find((d) => d.kind === 'help_me_pick');
    if (first && first.kind === 'help_me_pick') {
      args.onTrace?.({ kind: 'swap', op: 'help_me_pick' });
      return { kind: 'help_me_pick', optionsText: first.optionsText };
    }
  }

  // Keep only apply/preview-shaped decisions as candidates; discard help-
  // me-pick / clarify / hard-no at this granularity (the aggregate preview
  // text says "I can swap X in these batches" — the user picks).
  const packed: PendingSwapMultiBatch['candidates'] = [];
  for (let i = 0; i < usable.length; i++) {
    const t = usable[i]!;
    const d = decisions[i]!;
    const proposed = asPendingProposed(d, t);
    if (!proposed) continue;
    const description = describeTarget(t);
    const shortName = shortNameForTarget(t);
    const mealType = t.kind === 'batch'
      ? (t.recipe.mealTypes.includes('lunch')
          ? 'lunch'
          : t.recipe.mealTypes.includes('dinner')
            ? 'dinner'
            : 'breakfast')
      : 'breakfast';
    packed.push({
      targetId: t.targetId,
      description,
      shortName,
      mealType,
      proposed,
    });
  }

  // Plan 033: if exactly one candidate produced an apply/preview and every
  // other produced help_me_pick/clarify (e.g., breakfast doesn't really
  // fit the user's swap intent), treat this as an unambiguous single
  // target rather than a multi-batch preview. The apply-ready candidate
  // is what the user wanted.
  if (packed.length === 1) {
    const only = packed[0]!;
    const pending: PendingSwapSingle = {
      kind: 'single',
      targetId: only.targetId,
      originalRequest: args.request,
      proposed: only.proposed,
      reason: 'ambiguous_target',
      createdAt: now.toISOString(),
    };
    // If the proposed payload already had delta lines, this is an apply-
    // ready decision from its per-candidate agent call — commit it
    // immediately rather than routing back through the preview path.
    if (only.proposed.deltaLines && only.proposed.deltaLines.length > 0) {
      const applied = await commitPendingSwap({
        pending,
        store: args.store,
        recipes: args.recipes,
        llm: args.llm,
        now,
        ...(args.onTrace ? { onTrace: args.onTrace } : {}),
      });
      args.onTrace?.({ kind: 'swap', op: 'apply', targetId: applied.targetId });
      return { kind: 'applied', ...applied };
    }
    // Otherwise it was a preview — stash it as a single preview.
    args.onTrace?.({ kind: 'swap', op: 'preview', targetId: only.targetId, reason: 'ambiguous_target' });
    return {
      kind: 'preview',
      previewText: buildSingleCandidatePreview(only),
      pending,
    };
  }

  if (packed.length === 0) {
    // Every candidate produced non-commit (clarify / hard_no). Surface a
    // clarification question asking the user to narrow down.
    return {
      kind: 'clarification',
      question: "I see that ingredient in a few places. Which one did you want to swap?",
    };
  }

  const previewText = buildMultiBatchPreview(packed);
  const pending: PendingSwapMultiBatch = {
    kind: 'multi_batch',
    originalRequest: args.request,
    candidates: packed,
    previewText,
    reason: 'ambiguous_target',
    createdAt: now.toISOString(),
  };
  args.onTrace?.({ kind: 'swap', op: 'preview', reason: 'ambiguous_target' });
  return { kind: 'preview', previewText, pending };
}

/** Extract the proposed payload from either an apply- or preview-kind decision. */
function asPendingProposed(
  d: IngredientSwapDecision,
  t: SwapTarget,
): PendingSwapProposed | null {
  void t;
  if (d.kind === 'apply') {
    return {
      scaledIngredients: d.scaledIngredients,
      actualMacros: d.actualMacros,
      ...(d.nameOverride !== undefined ? { nameOverride: d.nameOverride } : {}),
      ...(d.bodyOverride !== undefined ? { bodyOverride: d.bodyOverride } : {}),
      changes: d.changes,
      deltaLines: d.deltaLines,
    };
  }
  if (d.kind === 'preview') {
    return {
      scaledIngredients: d.proposed.scaledIngredients,
      actualMacros: d.proposed.actualMacros,
      ...(d.proposed.nameOverride !== undefined ? { nameOverride: d.proposed.nameOverride } : {}),
      ...(d.proposed.bodyOverride !== undefined ? { bodyOverride: d.proposed.bodyOverride } : {}),
      changes: d.proposed.changes,
    };
  }
  return null;
}

function describeTarget(t: SwapTarget): string {
  if (t.kind === 'breakfast') {
    return `${t.recipe.shortName ?? t.recipe.name} (breakfast, every day)`;
  }
  const mealType = t.recipe.mealTypes.includes('lunch') ? 'lunch' : 'dinner';
  return `${t.recipe.shortName ?? t.recipe.name} (${mealType} ${t.eatingDays.join(', ')})`;
}

function shortNameForTarget(t: SwapTarget): string {
  return t.recipe.shortName ?? t.recipe.name;
}

function buildMultiBatchPreview(candidates: PendingSwapMultiBatch['candidates']): string {
  const header = `I can apply that swap in ${candidates.length} places:`;
  const rows = candidates.map((c, idx) => `${idx + 1}. ${c.description}`);
  const footer = `Pick "both", a number, or tell me which one by name.`;
  return [header, ...rows, '', footer].join('\n');
}

/**
 * Build a single-candidate preview summary from a packed candidate. Used
 * when only ONE candidate produced an apply/preview-shape proposal after
 * multi-batch resolution — the user's intent is unambiguous even though
 * multiple ingredients matched the scan.
 */
function buildSingleCandidatePreview(candidate: PendingSwapMultiBatch['candidates'][number]): string {
  const changeLines = candidate.proposed.changes.map(formatSwapChange);
  return [`Planning to swap on ${candidate.description}:`, ...changeLines, '', 'OK to apply?'].join('\n');
}

// ─── Commit entry points ────────────────────────────────────────────────

export async function commitPendingSwap(args: {
  pending: PendingSwapSingle;
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
  now?: Date;
  onTrace?: (event: TraceEvent) => void;
}): Promise<{ targetId: string; recipeSlug: string; cookViewText: string }> {
  const now = args.now ?? new Date();
  if (args.pending.targetId === 'breakfast') {
    return commitBreakfastPending(args, now);
  }
  return commitBatchPending(args, now);
}

async function commitBatchPending(
  args: {
    pending: PendingSwapSingle;
    store: StateStoreLike;
    recipes: RecipeDatabase;
    onTrace?: (event: TraceEvent) => void;
  },
  now: Date,
): Promise<{ targetId: string; recipeSlug: string; cookViewText: string }> {
  const { pending } = args;
  const batch = await args.store.getBatch(pending.targetId);
  if (!batch) throw new Error(`commitPendingSwap: batch ${pending.targetId} not found.`);
  const recipe = args.recipes.getBySlug(batch.recipeSlug);
  if (!recipe) throw new Error(`commitPendingSwap: recipe ${batch.recipeSlug} not found.`);

  const appendedHistory: SwapRecord[] = [
    ...(batch.swapHistory ?? []),
    {
      appliedAt: now.toISOString(),
      userMessage: pending.originalRequest,
      changes: pending.proposed.changes,
      resultingMacros: pending.proposed.actualMacros,
    },
  ];
  const updated = await args.store.updateBatch(pending.targetId, {
    scaledIngredients: pending.proposed.scaledIngredients,
    actualPerServing: pending.proposed.actualMacros,
    ...(pending.proposed.nameOverride !== undefined ? { nameOverride: pending.proposed.nameOverride } : {}),
    ...(pending.proposed.bodyOverride !== undefined ? { bodyOverride: pending.proposed.bodyOverride } : {}),
    swapHistory: appendedHistory,
  });
  args.onTrace?.({ kind: 'persist', op: 'updateBatch', argSummary: pending.targetId });

  const deltaLines = pending.proposed.deltaLines && pending.proposed.deltaLines.length > 0
    ? pending.proposed.deltaLines
    : pending.proposed.changes.map(formatSwapChange);
  const cookViewText = renderCookView(recipe, updated, { deltaLines });
  return { targetId: pending.targetId, recipeSlug: recipe.slug, cookViewText };
}

async function commitBreakfastPending(
  args: {
    pending: PendingSwapSingle;
    store: StateStoreLike;
    recipes: RecipeDatabase;
    onTrace?: (event: TraceEvent) => void;
  },
  now: Date,
): Promise<{ targetId: string; recipeSlug: string; cookViewText: string }> {
  const { pending } = args;
  // Breakfast commit requires the current plan session — read it fresh.
  const today = toLocalISODate(now);
  const planSession = await getVisiblePlanSession(args.store, today);
  if (!planSession) {
    throw new Error('commitPendingSwap(breakfast): no active plan session.');
  }
  const recipe = args.recipes.getBySlug(planSession.breakfast.recipeSlug);
  if (!recipe) throw new Error(`commitPendingSwap(breakfast): recipe ${planSession.breakfast.recipeSlug} not found.`);
  const existing = planSession.breakfastOverride;
  const override: BreakfastOverride = {
    scaledIngredientsPerDay: pending.proposed.scaledIngredients,
    actualPerDay: pending.proposed.actualMacros,
    swapHistory: [
      ...(existing?.swapHistory ?? []),
      {
        appliedAt: now.toISOString(),
        userMessage: pending.originalRequest,
        changes: pending.proposed.changes,
        resultingMacros: pending.proposed.actualMacros,
      },
    ],
  };
  if (pending.proposed.nameOverride === null) {
    // cleared
  } else if (typeof pending.proposed.nameOverride === 'string') {
    override.nameOverride = pending.proposed.nameOverride;
  } else if (existing?.nameOverride) {
    override.nameOverride = existing.nameOverride;
  }
  if (pending.proposed.bodyOverride === null) {
    // cleared
  } else if (typeof pending.proposed.bodyOverride === 'string') {
    override.bodyOverride = pending.proposed.bodyOverride;
  } else if (existing?.bodyOverride) {
    override.bodyOverride = existing.bodyOverride;
  }
  const updatedSession = await args.store.updatePlanSessionBreakfast(planSession.id, override);
  args.onTrace?.({ kind: 'persist', op: 'updatePlanSessionBreakfast', argSummary: 'breakfast' });

  const deltaLines = pending.proposed.deltaLines && pending.proposed.deltaLines.length > 0
    ? pending.proposed.deltaLines
    : pending.proposed.changes.map(formatSwapChange);
  const cookViewText = renderBreakfastCookView(recipe, updatedSession, { deltaLines });
  return { targetId: 'breakfast', recipeSlug: recipe.slug, cookViewText };
}

export async function commitPendingSwapMulti(args: {
  pending: PendingSwapMultiBatch;
  selectedIds: string[];
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
  now?: Date;
  onTrace?: (event: TraceEvent) => void;
}): Promise<Array<{ targetId: string; recipeSlug: string; cookViewText: string }>> {
  const now = args.now ?? new Date();
  const out: Array<{ targetId: string; recipeSlug: string; cookViewText: string }> = [];
  for (const id of args.selectedIds) {
    const candidate = args.pending.candidates.find((c) => c.targetId === id);
    if (!candidate) continue;
    const single: PendingSwapSingle = {
      kind: 'single',
      targetId: candidate.targetId,
      originalRequest: args.pending.originalRequest,
      proposed: candidate.proposed,
      reason: args.pending.reason,
      createdAt: args.pending.createdAt,
    };
    const result = await commitPendingSwap({
      pending: single,
      store: args.store,
      recipes: args.recipes,
      llm: args.llm,
      now,
      ...(args.onTrace ? { onTrace: args.onTrace } : {}),
    });
    out.push(result);
  }
  return out;
}
