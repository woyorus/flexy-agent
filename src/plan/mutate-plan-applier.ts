/**
 * Mutate-plan applier — Plan 029 / Plan D from proposal
 * `003-freeform-conversation-layer.md`.
 *
 * Shared entry point that runs either the in-session mutation path (delegating
 * to `plan-flow.ts` `handleMutationText`) or the post-confirmation mutation
 * path (using Plan 026's split-aware adapter + re-proposer + solver + diff +
 * `buildReplacingDraft`). Task 4 lands only the `PendingMutation` type so
 * `BotCoreSession` can reference it. Tasks 6–8 add the applier functions.
 *
 * This file will grow across:
 *   - Task 4: PendingMutation type (this file's initial shape)
 *   - Task 6: MutateResult union + applyMutationRequest scaffold
 *   - Task 7: in-session branch
 *   - Task 8: post-confirmation branch
 *   - Task 10 (core.ts import): applyMutationConfirmation helper for mp_confirm
 */

import type { Batch, FlexSlot, MealEvent, MutationRecord } from '../models/types.js';
import type { PlanProposal } from '../solver/types.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import type { StateStoreLike } from '../state/store.js';
import type { PlanFlowState } from '../agents/plan-flow.js';
import { log } from '../debug/logger.js';

/**
 * A proposed post-confirmation mutation awaiting explicit user confirmation.
 *
 * Stashed on `BotCoreSession.pendingMutation` when the applier's post-
 * confirmation branch returns a proposed diff. The `mp_confirm` callback
 * handler in `core.ts` reads it, calls `buildReplacingDraft`, and persists
 * via `confirmPlanSessionReplacing`. The `mp_adjust` callback clears it so
 * the next user message can propose a different mutation.
 *
 * NOT persisted. Bot restarts drop in-progress mutation proposals, same as
 * they drop in-progress planning flows.
 */
export interface PendingMutation {
  /** The session ID being replaced. `confirmPlanSessionReplacing` tombstones it on confirm. */
  oldSessionId: string;
  /**
   * Batches that live entirely in past slots (by the Plan 026 adapter's
   * classification at propose time). Preserved verbatim into the new
   * session's write payload so the full horizon renders correctly.
   */
  preservedPastBatches: Batch[];
  /**
   * Flex slots whose `(day, mealTime)` classified as past at propose time.
   * Plan 026's `sessionToPostConfirmationProposal` filters these out of the
   * `activeProposal` the re-proposer sees — they must round-trip through
   * `buildReplacingDraft` into the rewritten session or the user's historical
   * record of past flex decisions is erased on every mutate.
   */
  preservedPastFlexSlots: FlexSlot[];
  /**
   * Meal events whose `(day, mealTime)` classified as past at propose time.
   * Same preservation contract as `preservedPastFlexSlots`.
   */
  preservedPastEvents: MealEvent[];
  /**
   * The re-proposer's output for the active slice. Contains the new batches,
   * flex slots, events, and `solverOutput` (attached by the applier after it
   * runs the solver on the re-proposed active proposal). Plan 026's
   * `buildReplacingDraft` reads `reProposedActive.solverOutput.batchTargets`
   * as the macro-target source when scaling the new Batch rows — so this
   * field's `solverOutput` MUST be populated before the `PendingMutation`
   * is stashed.
   */
  reProposedActive: PlanProposal;
  /**
   * The mutation record to append to the new session's `mutationHistory`.
   * Constructed at propose time with the user's raw request as `constraint`
   * and the propose-time ISO string as `appliedAt`.
   */
  newMutationRecord: MutationRecord;
  /**
   * ISO timestamp when this pending mutation was created. Used for debug
   * logging and for eventual staleness checks (not enforced in Plan D).
   */
  createdAt: string;
}

/**
 * The applier's discriminated-union result.
 *
 * - `in_session_updated` — the in-session branch delegated to
 *   `handleMutationText` which returned a new FlowResponse. The handler
 *   sends `text` with `planProposalKeyboard`.
 * - `post_confirmation_proposed` — the post-confirmation branch produced
 *   a proposed diff. The handler sends `text` with `mutateConfirmKeyboard`
 *   and stashes `pending` on `BotCoreSession.pendingMutation`.
 * - `clarification` — either branch returned a re-proposer clarification.
 * - `failure` — validation or LLM failure; the handler sends `message`
 *   and leaves state untouched.
 * - `no_target` — nothing to mutate (no active plan or planning flow).
 */
export type MutateResult =
  | { kind: 'in_session_updated'; text: string }
  | { kind: 'post_confirmation_proposed'; text: string; pending: PendingMutation }
  | { kind: 'clarification'; question: string }
  | { kind: 'failure'; message: string }
  | { kind: 'no_target'; message: string };

/** Arguments for the main entry point. */
export interface ApplyMutationRequestArgs {
  /** The user's raw natural-language mutation request. Passed through verbatim. */
  request: string;
  /** BotCoreSession-shaped slice — reads planFlow, mutates state in place on in-session branch. */
  session: {
    planFlow: PlanFlowState | null;
  };
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
  /** Clock injection — Plan D scenarios pass a frozen Date. Defaults to new Date() at call time. */
  now?: Date;
  /** Pending clarification from a prior post-confirmation turn (invariant #5). */
  pendingClarification?: { originalRequest: string };
}

/**
 * Apply a mutation request. Branches on `session.planFlow` presence:
 * in-session → `handleMutationText` delegation (Task 7), post-confirmation
 * → adapter + re-proposer + solver + diff (Task 8).
 */
export async function applyMutationRequest(
  args: ApplyMutationRequestArgs,
): Promise<MutateResult> {
  const { request, session, recipes, llm } = args;

  log.debug('MUTATE', `applyMutationRequest: "${request.slice(0, 80)}"`);

  // ── In-session branch ────────────────────────────────────────────
  if (session.planFlow && session.planFlow.phase === 'proposal') {
    return applyInSession(session.planFlow, request, llm, recipes);
  }

  // ── Post-confirmation branch ──────────────────────────────────────
  return applyPostConfirmation(args);
}

/**
 * In-session branch — delegates to `plan-flow.ts` `handleMutationText`
 * unchanged. The existing function handles the re-proposer call, the
 * validation retry, the solver invocation, the diff summary, and the
 * mutation-history append. We map its `FlowResponse` output to
 * `MutateResult`.
 */
async function applyInSession(
  state: PlanFlowState,
  request: string,
  llm: LLMProvider,
  recipes: RecipeDatabase,
): Promise<MutateResult> {
  const { handleMutationText } = await import('../agents/plan-flow.js');
  const response = await handleMutationText(state, request, llm, recipes);

  // handleMutationText distinguishes its three outcomes by:
  //   - pendingClarification set → clarification
  //   - text includes "Your week:" → updated proposal
  //   - otherwise → failure
  if (state.pendingClarification) {
    return { kind: 'clarification', question: response.text };
  }

  if (response.text.includes('Your week:')) {
    return { kind: 'in_session_updated', text: response.text };
  }

  return { kind: 'failure', message: response.text };
}

/**
 * Post-confirmation branch — the core of Plan D.
 *
 * Loads the active persisted PlanSession + batches via the store, runs the
 * Plan 026 adapter to split the plan at the (date, mealType) cutoff, calls
 * the re-proposer in `post-confirmation` mode with `nearFutureDays`, runs
 * the solver on the re-proposer's active output, diffs against the pre-
 * mutation active view, and assembles a PendingMutation for the confirm tap.
 */
async function applyPostConfirmation(
  args: ApplyMutationRequestArgs,
): Promise<MutateResult> {
  const { store, recipes, llm } = args;
  const now = args.now ?? new Date();

  // If there's a pending clarification from a prior turn, prepend the original
  // request so the re-proposer has full context (invariant #5).
  let request = args.request;
  if (args.pendingClarification) {
    request = `${args.pendingClarification.originalRequest}. To clarify: ${request}`;
  }

  const { sessionToPostConfirmationProposal } = await import('./session-to-proposal.js');
  const { reProposePlan } = await import('../agents/plan-reproposer.js');
  const { solve } = await import('../solver/solver.js');
  const { buildSolverInput } = await import('../agents/plan-flow.js');
  const { diffProposals } = await import('../agents/plan-diff.js');
  const { buildRecipeSummaries } = await import('../agents/plan-proposer.js');
  const { toLocalISODate } = await import('./helpers.js');
  const { config } = await import('../config.js');

  // 1. Load the active plan.
  const today = toLocalISODate(now);
  let activeSession = await store.getRunningPlanSession(today);
  if (!activeSession) {
    const future = await store.getFuturePlanSessions(today);
    activeSession = future[0] ?? null;
  }
  if (!activeSession) {
    log.debug('MUTATE', 'no active plan — returning no_target');
    return {
      kind: 'no_target',
      message: "You don't have a plan yet. Tap 📋 Plan Week to start one.",
    };
  }

  const activeBatches = await store.getBatchesByPlanSessionId(activeSession.id);

  // 2. Split the plan at the cutoff boundary.
  const forward = sessionToPostConfirmationProposal(activeSession, activeBatches, now);
  const preMutationActive = forward.activeProposal;

  // 3. Call the re-proposer in post-confirmation mode.
  //
  // Both `activeHorizonDays` and `preCommittedSlots` come from the forward
  // adapter. Trimming the horizon to forward-only keeps past slots out of the
  // validator's coverage check (they're historical record, not slots the
  // re-proposer can modify); materializing past batches as pre-committed
  // slots gives the solver the consumed calorie/protein mass to subtract
  // from the weekly budget, and lets invariant #9 catch any accidental
  // displacement. See sessionToPostConfirmationProposal for the contract.
  const result = await reProposePlan(
    {
      currentProposal: preMutationActive,
      userMessage: request,
      mutationHistory: activeSession.mutationHistory,
      availableRecipes: buildRecipeSummaries(recipes.getAll()),
      horizonDays: forward.activeHorizonDays,
      preCommittedSlots: forward.preCommittedSlots,
      breakfast: {
        name: activeSession.breakfast.recipeSlug,
        caloriesPerDay: activeSession.breakfast.caloriesPerDay,
        proteinPerDay: activeSession.breakfast.proteinPerDay,
      },
      weeklyTargets: config.targets.weekly,
      mode: 'post-confirmation',
      nearFutureDays: forward.nearFutureDays,
    },
    llm,
    recipes,
  );

  // 4. Handle clarification / failure.
  if (result.type === 'clarification') {
    return { kind: 'clarification', question: result.question };
  }
  if (result.type === 'failure') {
    return { kind: 'failure', message: result.message };
  }

  // 5. Run the solver on the re-proposed active proposal.
  const proposal = result.proposal;
  const flowShim: PlanFlowState = {
    phase: 'proposal',
    weekStart: activeSession.horizonStart,
    weekDays: forward.activeHorizonDays,
    horizonStart: activeSession.horizonStart,
    horizonDays: forward.activeHorizonDays,
    breakfast: {
      recipeSlug: activeSession.breakfast.recipeSlug,
      name: activeSession.breakfast.recipeSlug,
      caloriesPerDay: activeSession.breakfast.caloriesPerDay,
      proteinPerDay: activeSession.breakfast.proteinPerDay,
    },
    events: proposal.events,
    proposal,
    mutationHistory: activeSession.mutationHistory,
    preCommittedSlots: forward.preCommittedSlots,
  };
  const solverInput = buildSolverInput(flowShim, proposal, recipes, forward.preCommittedSlots);
  proposal.solverOutput = solve(solverInput);

  // 6. Generate the diff against the pre-mutation view.
  const summary = diffProposals(preMutationActive, proposal);

  // 7. Assemble the PendingMutation.
  const pending: PendingMutation = {
    oldSessionId: activeSession.id,
    preservedPastBatches: forward.preservedPastBatches,
    preservedPastFlexSlots: forward.preservedPastFlexSlots,
    preservedPastEvents: forward.preservedPastEvents,
    reProposedActive: proposal,
    newMutationRecord: {
      constraint: request,
      appliedAt: now.toISOString(),
    },
    createdAt: now.toISOString(),
  };

  const text = [
    summary,
    '',
    'Tap Confirm to lock this in, or Adjust to change something.',
  ].join('\n');

  return {
    kind: 'post_confirmation_proposed',
    text,
    pending,
  };
}

/**
 * Persist a pending mutation. Called from the mp_confirm callback in
 * core.ts. Wraps `buildReplacingDraft` + `confirmPlanSessionReplacing` and
 * returns the persisted new session.
 */
export async function applyMutationConfirmation(args: {
  pending: PendingMutation;
  store: StateStoreLike;
  recipes: RecipeDatabase;
  llm: LLMProvider;
}): Promise<{
  newSessionId: string;
  persistedText: string;
}> {
  const { pending, store, recipes, llm } = args;

  const oldSession = await store.getPlanSession(pending.oldSessionId);
  if (!oldSession) {
    throw new Error(`applyMutationConfirmation: old session ${pending.oldSessionId} not found`);
  }

  const { buildReplacingDraft } = await import('./session-to-proposal.js');
  const { draft, batches: writeBatches } = await buildReplacingDraft({
    oldSession,
    preservedPastBatches: pending.preservedPastBatches,
    preservedPastFlexSlots: pending.preservedPastFlexSlots,
    preservedPastEvents: pending.preservedPastEvents,
    reProposedActive: pending.reProposedActive,
    newMutation: pending.newMutationRecord,
    recipeDb: recipes,
    llm,
    calorieTolerance: (await import('../config.js')).config.planning.scalerCalorieTolerance,
  });

  // Copy treat budget from the old session (conservative default — see decision log).
  (draft as import('../models/types.js').DraftPlanSession).treatBudgetCalories = oldSession.treatBudgetCalories;

  const persisted = await store.confirmPlanSessionReplacing(
    draft,
    writeBatches,
    pending.oldSessionId,
  );

  log.info(
    'MUTATE',
    `post-confirmation mutation persisted: old=${pending.oldSessionId} new=${persisted.id}`,
  );

  const persistedText =
    `Plan updated. Your week is locked in.\n\n` +
    `Note: I shifted meals around but don't track meal-out calories yet — ` +
    `that comes with deviation accounting later.`;

  return {
    newSessionId: persisted.id,
    persistedText,
  };
}
