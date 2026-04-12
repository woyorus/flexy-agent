/**
 * Session-to-proposal adapter — Plan 026.
 *
 * Converts a persisted `PlanSession + Batch[]` into the in-memory
 * `PlanProposal` shape the re-proposer consumes, splitting the plan at the
 * (date, mealType) level using server-local wall-clock cutoffs. The split
 * boundary determines which slots are "past" (frozen, preserved verbatim) and
 * which are "active" (sent to the re-proposer for mutation).
 *
 * This file is pure — no store calls, no LLM calls, no clock reads beyond
 * the `now: Date` passed in by the caller. All downstream logic (re-proposer
 * invocation, write via confirmPlanSessionReplacing) is wired up by the
 * caller (Plan D). Plan 026 only ships the adapter and its unit tests.
 *
 * Design doc: docs/design-docs/proposals/003-freeform-conversation-layer.md
 */

import { randomUUID } from 'node:crypto';
import type {
  Batch,
  DraftPlanSession,
  FlexSlot,
  MealEvent,
  MutationRecord,
  PlanSession,
  ScaledIngredient,
} from '../models/types.js';
import type { PlanProposal, PreCommittedSlot, ProposedBatch } from '../solver/types.js';
import type { LLMProvider } from '../ai/provider.js';
import type { RecipeDatabase } from '../recipes/database.js';
import { toLocalISODate } from './helpers.js';

/**
 * Server-local hour (24h) after which "today's lunch" is considered past.
 * 15:00 means lunch is active until 2:59pm and past from 3:00pm onward.
 * Chosen per proposal 003 as the pragmatic default for the single-user v0.0.5
 * simplification; can be revisited when multi-user timezone support lands.
 */
export const LUNCH_DONE_CUTOFF_HOUR = 15;

/**
 * Server-local hour (24h) after which "today's dinner" is considered past.
 * 21:00 means dinner is active until 8:59pm and past from 9:00pm onward.
 */
export const DINNER_DONE_CUTOFF_HOUR = 21;

/**
 * Classify a single slot as past or active relative to `now`.
 *
 * A slot is "past" when any of:
 *   (a) its date is strictly before today's local date;
 *   (b) it's today's lunch and now >= 15:00 local;
 *   (c) it's today's dinner and now >= 21:00 local.
 *
 * Otherwise it's "active" and the re-proposer is allowed to see and mutate it.
 *
 * @param day - ISO date of the slot
 * @param mealType - 'lunch' or 'dinner' (breakfast is never part of a batch)
 * @param now - Current wall clock; read only for hour/ISO date, never Date.now()
 */
export function classifySlot(day: string, mealType: 'lunch' | 'dinner', now: Date): 'past' | 'active' {
  const today = toLocalISODate(now);
  if (day < today) return 'past';
  if (day > today) return 'active';
  // day === today: use meal cutoff.
  const hour = now.getHours();
  if (mealType === 'lunch') return hour >= LUNCH_DONE_CUTOFF_HOUR ? 'past' : 'active';
  return hour >= DINNER_DONE_CUTOFF_HOUR ? 'past' : 'active';
}

/**
 * Result of classifying a single batch against the current wall clock.
 *
 * - `past-only`: every eating day is strictly past. The batch is preserved
 *   verbatim and flows into the write payload unchanged.
 * - `active-only`: every eating day is strictly active. The batch is rendered
 *   as a `ProposedBatch` for the re-proposer to see and potentially mutate.
 * - `spanning`: some eating days are past, others active. Task 9 splits these
 *   into a past half (Batch) and an active half (ProposedBatch).
 */
export type SplitBatchResult =
  | { kind: 'past-only'; pastBatch: Batch }
  | { kind: 'active-only'; activeBatch: ProposedBatch }
  | { kind: 'spanning'; pastBatch: Batch; activeBatch: ProposedBatch };

/**
 * Split a single persisted batch across the (date, mealType) cutoff.
 *
 * Determines whether the batch is past-only, active-only, or spanning, and
 * returns the pieces needed to reconstruct the plan after the re-proposer
 * runs on the active portion. Pure — never reads real clocks or recipes.
 *
 * @param batch - A persisted Batch loaded from the store
 * @param now - Current wall clock
 */
export function splitBatchAtCutoffs(batch: Batch, now: Date): SplitBatchResult {
  const pastDays: string[] = [];
  const activeDays: string[] = [];
  for (const day of batch.eatingDays) {
    if (classifySlot(day, batch.mealType, now) === 'past') {
      pastDays.push(day);
    } else {
      activeDays.push(day);
    }
  }

  if (pastDays.length === 0) {
    return {
      kind: 'active-only',
      activeBatch: {
        recipeSlug: batch.recipeSlug,
        // Recipe display name isn't stored on Batch — caller resolves it later
        // if needed. For now use the slug as a placeholder; downstream code
        // resolves via RecipeDatabase when it prints anything.
        recipeName: batch.recipeSlug,
        mealType: batch.mealType,
        days: activeDays,
        servings: activeDays.length,
        overflowDays: undefined,
      },
    };
  }

  if (activeDays.length === 0) {
    return { kind: 'past-only', pastBatch: batch };
  }

  // Spanning: past days keep their original scaled totals scaled down
  // proportionally, and get a fresh id (the past half becomes a new row in
  // the next session). Active days become a ProposedBatch for the re-proposer.
  const pastBatch: Batch = {
    id: randomUUID(),
    recipeSlug: batch.recipeSlug,
    mealType: batch.mealType,
    eatingDays: pastDays,
    servings: pastDays.length,
    targetPerServing: batch.targetPerServing,
    actualPerServing: batch.actualPerServing,
    scaledIngredients: scaleIngredientTotals(batch.scaledIngredients, pastDays.length, batch.servings),
    status: 'planned',
    createdInPlanSessionId: batch.createdInPlanSessionId,
  };

  const activeBatch: ProposedBatch = {
    recipeSlug: batch.recipeSlug,
    recipeName: batch.recipeSlug,
    mealType: batch.mealType,
    days: activeDays,
    servings: activeDays.length,
    overflowDays: undefined,
  };

  return { kind: 'spanning', pastBatch, activeBatch };
}

/**
 * Proportionally scale a batch's ingredient amounts for a reduced serving count.
 *
 * `scaledIngredients[i].totalForBatch` was computed at plan time as
 * `recipe.ingredients[i].amount * originalServings` (see
 * `src/agents/plan-flow.ts:911`). When we split a batch, each half gets a
 * proportional share of the totals. Per-serving `amount` / `unit` stay
 * unchanged.
 */
function scaleIngredientTotals<T extends { amount: number; totalForBatch: number }>(
  items: T[],
  newServings: number,
  originalServings: number,
): T[] {
  if (originalServings === 0) return items;
  const ratio = newServings / originalServings;
  return items.map((it) => ({
    ...it,
    totalForBatch: Math.round(it.totalForBatch * ratio),
  }));
}

/**
 * Forward-adapter result. `activeProposal` is the shape the re-proposer accepts;
 * `preservedPastBatches` are the batches (and split halves of spanning batches)
 * that belong entirely to past slots and must be written unchanged into the
 * new session at round-trip time. `preservedPastFlexSlots` and
 * `preservedPastEvents` are the flex slots and meal events whose `day`+`mealTime`
 * classify as past at `now` — the re-proposer never sees them but they must
 * round-trip into the rewritten session so the user's historical record is not
 * erased on every mutate. `nearFutureDays` captures the 2-day soft-locked
 * window for the re-proposer's post-confirmation safety rule.
 *
 * `horizonDays` is the FULL session horizon (used for round-trip / rendering).
 * `activeHorizonDays` is the subset from the cutoff forward — this is what the
 * re-proposer and its validator operate over, because past days are
 * historical record and must not be required to appear as proposal sources.
 * `preCommittedSlots` materializes the past eating days of `preservedPastBatches`
 * so the solver can subtract their consumed calories/protein from the weekly
 * budget (and so invariant #9 catches any accidental displacement of a past
 * slot by a new proposal).
 */
export interface PostConfirmationProposal {
  activeProposal: PlanProposal;
  preservedPastBatches: Batch[];
  preservedPastFlexSlots: FlexSlot[];
  preservedPastEvents: MealEvent[];
  horizonDays: string[];
  activeHorizonDays: string[];
  preCommittedSlots: PreCommittedSlot[];
  nearFutureDays: string[];
}

/**
 * Expand an ISO horizon (start + end) into the 7 ISO day strings it covers.
 */
function expandHorizonDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  while (d <= e) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

/**
 * The 2-day near-future soft-lock window for post-confirmation safety.
 * Returns today + tomorrow as ISO dates, intersected with the horizon so we
 * never produce days outside the session range.
 */
function computeNearFutureDays(now: Date, horizonDays: string[]): string[] {
  const today = toLocalISODate(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = toLocalISODate(tomorrow);
  return [today, tomorrowISO].filter((d) => horizonDays.includes(d));
}

/**
 * Convert a persisted PlanSession + its Batch[] into the re-proposer's
 * in-memory PlanProposal shape, splitting at the (date, mealType) level.
 *
 * The result's `activeProposal` contains only batches, flex slots, and events
 * that fall on active slots — past slots are frozen and never shown to the
 * re-proposer. The `preservedPastBatches` array contains Batches that must
 * flow through the round-trip unchanged (pure-past batches) or with
 * proportionally split ingredient totals (past halves of spanning batches).
 *
 * @param session - The confirmed plan session loaded from the store
 * @param batches - All batches whose createdInPlanSessionId === session.id
 *                  (i.e., the result of store.getBatchesByPlanSessionId)
 * @param now - Current wall clock
 */
export function sessionToPostConfirmationProposal(
  session: PlanSession,
  batches: Batch[],
  now: Date,
): PostConfirmationProposal {
  const horizonDays = expandHorizonDays(session.horizonStart, session.horizonEnd);
  const preservedPastBatches: Batch[] = [];
  const activeBatches: ProposedBatch[] = [];

  for (const b of batches) {
    // Skip cancelled batches entirely — they don't belong to the live plan.
    if (b.status !== 'planned') continue;

    const split = splitBatchAtCutoffs(b, now);
    if (split.kind === 'past-only') {
      preservedPastBatches.push(split.pastBatch);
    } else if (split.kind === 'active-only') {
      activeBatches.push(split.activeBatch);
    } else {
      preservedPastBatches.push(split.pastBatch);
      activeBatches.push(split.activeBatch);
    }
  }

  // Sort active batches by first active day for stable output (scenario diffs).
  activeBatches.sort((a, b) => {
    const da = a.days[0] ?? '';
    const db = b.days[0] ?? '';
    if (da !== db) return da < db ? -1 : 1;
    return a.mealType < b.mealType ? -1 : 1;
  });

  // Flex slots and events: partition by classification at `now`. Active ones
  // go to `activeProposal` (the re-proposer can see and rearrange them);
  // past ones go to `preservedPast*` (frozen historical record that the
  // round-trip splices back into the rewritten session). Dropping past ones
  // on the floor would erase the user's record of "Sunday dinner was a flex
  // slot" or "I ate out Monday" on every mutate — exactly the kind of silent
  // data loss the save-before-destroy model exists to prevent.
  const activeFlexSlots: FlexSlot[] = [];
  const preservedPastFlexSlots: FlexSlot[] = [];
  for (const fs of session.flexSlots) {
    if (classifySlot(fs.day, fs.mealTime, now) === 'active') {
      activeFlexSlots.push(fs);
    } else {
      preservedPastFlexSlots.push(fs);
    }
  }

  const activeEvents: MealEvent[] = [];
  const preservedPastEvents: MealEvent[] = [];
  for (const ev of session.events) {
    if (classifySlot(ev.day, ev.mealTime, now) === 'active') {
      activeEvents.push(ev);
    } else {
      preservedPastEvents.push(ev);
    }
  }

  const activeProposal: PlanProposal = {
    batches: activeBatches,
    flexSlots: activeFlexSlots,
    events: activeEvents,
    recipesToGenerate: [],
  };

  // Trim the horizon at the cutoff. The re-proposer / validator only walks
  // these days: past days are historical record, not slots that need a
  // proposal source. Kept as a plain filter on `horizonDays` (not on `now`)
  // so the split here matches classifySlot's day-level classification used
  // above for batches/flex/events.
  const today = toLocalISODate(now);
  const activeHorizonDays = horizonDays.filter((d) => d >= today);

  // Materialize pre-committed slots from every preserved past source — past
  // batches, past flex slots, and past meal events. Three reasons all three
  // matter:
  //
  //   1. The validator walks `activeHorizonDays × {lunch, dinner}` and requires
  //      a source per slot. `activeHorizonDays` is day-granular, while
  //      `classifySlot()` is slot-granular — so a mid-day mutation after the
  //      lunch cutoff (15:00 local) leaves today's lunch in the past half even
  //      though today stays in the active horizon. Without a pre-committed
  //      entry for that consumed lunch slot, invariant #1 fires on the
  //      already-past slot even when the underlying source was a flex or an
  //      event, not a batch.
  //   2. The solver subtracts pre-committed calories/protein from the weekly
  //      budget, so past flex bonuses and past event calories get deducted
  //      from the forward allocation — matching the fact that the user has
  //      already consumed them.
  //   3. Validator invariant #9 ("proposal must not displace a pre-committed
  //      slot") keeps the re-proposer from silently reassigning a slot the
  //      user has already lived through.
  //
  // Synthetic slug/sourceBatchId values: flex and events have no backing
  // Recipe, so the slug is a human-readable marker (displayed in the
  // re-proposer's prompt under "Pre-committed slots") and the sourceBatchId
  // uses a distinguishable prefix so nothing downstream confuses it for a
  // real batch id.
  const preCommittedSlots: PreCommittedSlot[] = [];
  for (const past of preservedPastBatches) {
    for (const day of past.eatingDays) {
      preCommittedSlots.push({
        day,
        mealTime: past.mealType,
        recipeSlug: past.recipeSlug,
        calories: past.actualPerServing.calories,
        protein: past.actualPerServing.protein,
        sourceBatchId: past.id,
      });
    }
  }
  for (const flex of preservedPastFlexSlots) {
    preCommittedSlots.push({
      day: flex.day,
      mealTime: flex.mealTime,
      recipeSlug: '(flex meal)',
      calories: flex.flexBonus,
      protein: 0,
      sourceBatchId: `past-flex:${flex.day}:${flex.mealTime}`,
    });
  }
  for (const ev of preservedPastEvents) {
    preCommittedSlots.push({
      day: ev.day,
      mealTime: ev.mealTime,
      recipeSlug: ev.name,
      calories: ev.estimatedCalories,
      protein: 0,
      sourceBatchId: `past-event:${ev.day}:${ev.mealTime}`,
    });
  }

  return {
    activeProposal,
    preservedPastBatches,
    preservedPastFlexSlots,
    preservedPastEvents,
    horizonDays,
    activeHorizonDays,
    preCommittedSlots,
    nearFutureDays: computeNearFutureDays(now, horizonDays),
  };
}

// ─── Round-trip back to the store ───────────────────────────────────────────

export interface BuildReplacingDraftArgs {
  /** The session being replaced. Its horizon is copied into the new draft. */
  oldSession: PlanSession;
  /** Past batches to preserve verbatim (re-pointed at the new session id). */
  preservedPastBatches: Batch[];
  /**
   * Past flex slots to preserve verbatim. These are the user's historical
   * "I put a flex meal on Sunday dinner" decisions — dropping them on the
   * floor would erase the user's record of what actually happened in the
   * earlier half of the week. Sourced from `sessionToPostConfirmationProposal`.
   */
  preservedPastFlexSlots: FlexSlot[];
  /**
   * Past meal events to preserve verbatim. These are the user's historical
   * "I ate out on Monday" / "breakfast out Tuesday" records — also must
   * survive the rewrite. Sourced from `sessionToPostConfirmationProposal`.
   */
  preservedPastEvents: MealEvent[];
  /** The re-proposer's output for the active window. */
  reProposedActive: PlanProposal;
  /** The just-approved mutation to append to history. */
  newMutation: MutationRecord;
  recipeDb: RecipeDatabase;
  llm: LLMProvider;
  /**
   * Calorie tolerance passed to the recipe scaler. Plan 029: threaded from
   * `config.planning.scalerCalorieTolerance` by the mutate-plan applier.
   */
  calorieTolerance: number;
}

export interface BuildReplacingDraftResult {
  draft: DraftPlanSession;
  batches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>>;
}

/**
 * Assemble the DraftPlanSession and Batch[] write payload that closes the
 * round-trip after the re-proposer has run on the active slice of a
 * confirmed plan. Produces exactly the shape that `confirmPlanSessionReplacing`
 * wants.
 *
 * Not pure — it calls the recipe scaler to populate `scaledIngredients` /
 * `actualPerServing` on new active batches. The scaler is the same one
 * `plan-flow.ts buildNewPlanSession` uses, so behavior parity is by design.
 * Preserved past batches are re-pointed at the new session id and given fresh
 * UUIDs but otherwise passed through unchanged (their scaledIngredients were
 * already scaled at plan time, and the split logic in splitBatchAtCutoffs
 * adjusts totals when a spanning batch is cut).
 *
 * `reProposedActive.solverOutput` MUST be populated by the caller (Plan D's
 * applier runs the solver before invoking this function). Without it the
 * function throws — there is no per-batch macro target to write.
 */
export async function buildReplacingDraft(
  args: BuildReplacingDraftArgs,
): Promise<BuildReplacingDraftResult> {
  const newSessionId = randomUUID();

  const draft: DraftPlanSession = {
    id: newSessionId,
    horizonStart: args.oldSession.horizonStart,
    horizonEnd: args.oldSession.horizonEnd,
    breakfast: args.oldSession.breakfast,
    treatBudgetCalories: args.oldSession.treatBudgetCalories,
    // Concatenate preserved past + re-proposed active for both flex slots
    // and events. The past arrays are frozen historical records that must
    // round-trip into the rewritten session (the re-proposer never saw them
    // and did not touch them; they simply pass through).
    flexSlots: [...args.preservedPastFlexSlots, ...args.reProposedActive.flexSlots],
    events: [...args.preservedPastEvents, ...args.reProposedActive.events],
    mutationHistory: [...args.oldSession.mutationHistory, args.newMutation],
  };

  const writeBatches: Array<Omit<Batch, 'createdAt' | 'updatedAt'>> = [];

  // 1. Preserved past batches — new id + new session id, everything else stays.
  for (const past of args.preservedPastBatches) {
    writeBatches.push({
      ...past,
      id: randomUUID(),
      createdInPlanSessionId: newSessionId,
    });
  }

  // 2. Re-proposed active batches — use solver output, scale each batch fresh.
  // This mirrors plan-flow.ts:874-938 (first-confirmation write path) so the
  // two code paths produce structurally identical Batch rows.
  const solverOutput = args.reProposedActive.solverOutput;
  if (!solverOutput) {
    throw new Error(
      'buildReplacingDraft: reProposedActive.solverOutput is missing. ' +
      'The caller (Plan D applier) must run the solver on the re-proposer output ' +
      'before invoking buildReplacingDraft.',
    );
  }

  for (const batchTarget of solverOutput.batchTargets) {
    // Match plan-flow.ts:878-882's tuple key: (recipeSlug, mealType, days[0]).
    // days[0] disambiguates when the same (recipeSlug, mealType) appears in
    // two batches after re-batching (Plan 009).
    const proposedBatch = args.reProposedActive.batches.find(
      (b) =>
        b.recipeSlug === batchTarget.recipeSlug &&
        b.mealType === batchTarget.mealType &&
        b.days[0] === batchTarget.days[0],
    );
    if (!proposedBatch) {
      throw new Error(
        `buildReplacingDraft: solver BatchTarget ${batchTarget.recipeSlug}:${batchTarget.mealType}:${batchTarget.days[0]} ` +
        `has no matching re-proposed batch — solver output and re-proposer output are out of sync.`,
      );
    }
    const recipe = batchTarget.recipeSlug ? args.recipeDb.getBySlug(batchTarget.recipeSlug) : undefined;
    const overflowDays = proposedBatch.overflowDays ?? [];
    const eatingDays = [...batchTarget.days, ...overflowDays];

    let actualPerServing = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    let scaledIngredients: ScaledIngredient[] = [];

    if (recipe) {
      // Fallback branch matches plan-flow.ts:904-914 exactly: on any scaler
      // failure, fall back to per-serving amounts multiplied by servings.
      try {
        const { scaleRecipe } = await import('../agents/recipe-scaler.js');
        const scaled = await scaleRecipe({
          recipe,
          // Use the SOLVER-produced target, not recipe.perServing — the solver
          // has already allocated macros across the week's batches given the
          // weekly totals, flex bonuses, event offsets, and treat budget.
          targetCalories: batchTarget.targetPerServing.calories,
          calorieTolerance: args.calorieTolerance,
          targetProtein: batchTarget.targetPerServing.protein,
          servings: eatingDays.length, // Plan 010: total portions, not solver servings
        }, args.llm);
        actualPerServing = scaled.actualPerServing;
        scaledIngredients = scaled.scaledIngredients;
      } catch {
        actualPerServing = recipe.perServing;
        scaledIngredients = recipe.ingredients.map((ing) => ({
          name: ing.name,
          amount: ing.amount,
          unit: ing.unit,
          totalForBatch: ing.amount * eatingDays.length,
          role: ing.role,
        }));
      }
    }

    writeBatches.push({
      id: randomUUID(),
      recipeSlug: batchTarget.recipeSlug ?? '',
      mealType: batchTarget.mealType,
      eatingDays,
      servings: eatingDays.length,
      // Write the solver's target as-is. `actualPerServing` is what the scaler
      // produced; `targetPerServing` is the solver's allocation target. These
      // are allowed to differ within the scaler's calorie tolerance.
      targetPerServing: batchTarget.targetPerServing,
      actualPerServing,
      scaledIngredients,
      status: 'planned',
      createdInPlanSessionId: newSessionId,
    });
  }

  return { draft, batches: writeBatches };
}
