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

import type { Batch, FlexSlot, MealEvent } from '../models/types.js';
import type { PlanProposal } from '../solver/types.js';
import type { MutationRecord } from '../models/types.js';

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
