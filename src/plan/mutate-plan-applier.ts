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

  // ── Post-confirmation branch — Task 8 fills this in ──
  // ── No-target branch — Task 8 also handles this ──
  throw new Error('applyMutationRequest: post-confirmation branch not wired yet (Task 8)');
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
