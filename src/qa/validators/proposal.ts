/**
 * Proposal validator — gates every PlanProposal before the solver sees it.
 *
 * Plan 024: replaces the ad-hoc orphan flow gate (computeUnexplainedOrphans retry
 * in handleGenerateProposal) with a structured validation that checks 13 invariants.
 * The proposer calls this after mapToProposal(); if invalid, it retries once with
 * the error messages fed back to the LLM as a correction prompt.
 *
 * Invariants are derived from the design doc (docs/design-docs/proposals/002).
 */

import type { PlanProposal, PreCommittedSlot } from '../../solver/types.js';
import type { RecipeDatabase } from '../../recipes/database.js';
import { config } from '../../config.js';

export interface ProposalValidationResult {
  valid: boolean;
  /** Hard failures — proposal rejected */
  errors: string[];
  /** Soft issues — logged, not blocking */
  warnings: string[];
}

/**
 * Validate a PlanProposal against the 13 structural invariants.
 *
 * @param proposal - The proposal to validate
 * @param recipeDb - Recipe database for slug existence and fridge-life checks
 * @param horizonDays - ISO dates covering the plan horizon
 * @param preCommittedSlots - Pre-committed slots from prior sessions
 * @returns Validation result with errors and warnings
 */
export function validateProposal(
  proposal: PlanProposal,
  recipeDb: RecipeDatabase,
  horizonDays: string[],
  preCommittedSlots: PreCommittedSlot[],
): ProposalValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const horizonSet = new Set(horizonDays);

  // Build a map of all claimed (day, mealType) slots and their sources
  const slotSources = new Map<string, string[]>();
  const slotKey = (day: string, meal: string) => `${day}:${meal}`;

  const addSource = (day: string, meal: string, source: string) => {
    const key = slotKey(day, meal);
    const sources = slotSources.get(key) ?? [];
    sources.push(source);
    slotSources.set(key, sources);
  };

  // Batch days
  for (const [i, batch] of proposal.batches.entries()) {
    for (const day of batch.days) {
      addSource(day, batch.mealType, `batch[${i}]:${batch.recipeSlug}`);
    }
    if (batch.overflowDays) {
      for (const day of batch.overflowDays) {
        addSource(day, batch.mealType, `batch[${i}]:${batch.recipeSlug}(overflow)`);
      }
    }
  }

  // Flex slots
  for (const flex of proposal.flexSlots) {
    addSource(flex.day, flex.mealTime, 'flex');
  }

  // Events
  for (const event of proposal.events) {
    addSource(event.day, event.mealTime, `event:${event.name}`);
  }

  // Pre-committed slots — tracked separately from proposal sources.
  // The proposal must NOT claim slots occupied by pre-committed data (invariant 9).
  const preCommittedKeys = new Set(
    preCommittedSlots.map((pc) => slotKey(pc.day, pc.mealTime)),
  );

  // --- Invariant 1: Slot coverage ---
  for (const day of horizonDays) {
    for (const meal of ['lunch', 'dinner'] as const) {
      const key = slotKey(day, meal);
      if (!slotSources.has(key) && !preCommittedKeys.has(key)) {
        errors.push(`#1 Slot coverage: ${day} ${meal} has no source (batch, flex, event, or pre-committed)`);
      }
    }
  }

  // --- Invariant 2: No overlap ---
  for (const [key, sources] of slotSources) {
    if (sources.length > 1) {
      errors.push(`#2 Overlap: ${key} claimed by ${sources.join(' + ')}`);
    }
  }

  // --- Invariant 3: Eating days sorted ---
  for (const [i, batch] of proposal.batches.entries()) {
    for (let j = 1; j < batch.days.length; j++) {
      if (batch.days[j]! <= batch.days[j - 1]!) {
        errors.push(`#3 Sort: batch[${i}] days not ascending: ${batch.days.join(', ')}`);
        break;
      }
    }
  }

  // --- Invariant 4: Servings match ---
  for (const [i, batch] of proposal.batches.entries()) {
    const totalDays = batch.days.length + (batch.overflowDays?.length ?? 0);
    if (batch.servings !== totalDays) {
      errors.push(`#4 Servings: batch[${i}] servings=${batch.servings} but days+overflow=${totalDays}`);
    }
  }

  // --- Invariant 5: Servings range ---
  for (const [i, batch] of proposal.batches.entries()) {
    if (batch.servings < 1 || batch.servings > 3) {
      errors.push(`#5 Range: batch[${i}] servings=${batch.servings} outside [1,3]`);
    } else if (batch.servings === 1) {
      warnings.push(`#5 Range: batch[${i}] is 1-serving (prefer 2-3)`);
    }
  }

  // --- Invariant 6: Cook day in horizon ---
  for (const [i, batch] of proposal.batches.entries()) {
    if (batch.days.length > 0 && !horizonSet.has(batch.days[0]!)) {
      errors.push(`#6 Cook day: batch[${i}] cook day ${batch.days[0]} not in horizon`);
    }
  }

  // --- Invariant 7: Fridge life respected ---
  for (const [i, batch] of proposal.batches.entries()) {
    const recipe = recipeDb.getBySlug(batch.recipeSlug);
    if (!recipe) continue; // Invariant 10 catches missing recipes separately
    const firstDay = batch.days[0];
    const lastDay = batch.overflowDays?.at(-1) ?? batch.days.at(-1);
    if (firstDay && lastDay) {
      const span = calendarSpan(firstDay, lastDay);
      if (span > recipe.storage.fridgeDays) {
        errors.push(`#7 Fridge life: batch[${i}] ${batch.recipeSlug} spans ${span} days but fridgeDays=${recipe.storage.fridgeDays}`);
      }
    }
  }

  // --- Invariant 8: Flex count ---
  const expectedFlex = config.planning.flexSlotsPerWeek;
  if (proposal.flexSlots.length !== expectedFlex) {
    errors.push(`#8 Flex count: expected ${expectedFlex}, got ${proposal.flexSlots.length}`);
  }

  // --- Invariant 9: Pre-committed slots intact ---
  // The proposal must not displace pre-committed slots with batches, flex, or events.
  for (const pc of preCommittedSlots) {
    const key = slotKey(pc.day, pc.mealTime);
    const sources = slotSources.get(key);
    if (sources && sources.length > 0) {
      errors.push(`#9 Pre-committed: ${pc.day} ${pc.mealTime} (${pc.recipeSlug}) displaced by ${sources.join(', ')}`);
    }
  }

  // --- Invariant 10: Recipes exist ---
  for (const [i, batch] of proposal.batches.entries()) {
    if (!recipeDb.getBySlug(batch.recipeSlug)) {
      errors.push(`#10 Recipe missing: batch[${i}] slug '${batch.recipeSlug}' not in recipe DB`);
    }
  }

  // --- Invariant 14: Meal-type lane ---
  // Each batch's mealType must be in its recipe's authored mealTypes array.
  // Plan 026: prevents the re-proposer from placing a dinner-only recipe into
  // a lunch batch under post-confirmation rearrangement pressure. Skip batches
  // whose recipe is missing — invariant #10 catches those separately.
  for (const [i, batch] of proposal.batches.entries()) {
    const recipe = recipeDb.getBySlug(batch.recipeSlug);
    if (!recipe) continue;
    if (!recipe.mealTypes.includes(batch.mealType)) {
      errors.push(
        `#14 Meal-type lane: batch[${i}] ${batch.recipeSlug} is placed in ${batch.mealType} ` +
        `but recipe.mealTypes = [${recipe.mealTypes.join(', ')}]`,
      );
    }
  }

  // --- Invariant 11: Event dates in horizon ---
  for (const event of proposal.events) {
    if (!horizonSet.has(event.day)) {
      errors.push(`#11 Event date: '${event.name}' on ${event.day} not in horizon`);
    }
  }

  // --- Invariant 12: Event fields valid ---
  for (const event of proposal.events) {
    if (!event.name || event.name.trim().length === 0) {
      errors.push(`#12 Event field: event on ${event.day} has empty name`);
    }
    if (!['lunch', 'dinner'].includes(event.mealTime)) {
      errors.push(`#12 Event field: event '${event.name}' has invalid mealTime '${event.mealTime}'`);
    }
    if (!event.estimatedCalories || event.estimatedCalories <= 0) {
      errors.push(`#12 Event field: event '${event.name}' has non-positive estimatedCalories`);
    }
  }

  // --- Invariant 13: No duplicate events ---
  const eventKeys = new Set<string>();
  for (const event of proposal.events) {
    const key = slotKey(event.day, event.mealTime);
    if (eventKeys.has(key)) {
      errors.push(`#13 Duplicate event: ${event.day} ${event.mealTime}`);
    }
    eventKeys.add(key);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Compute the calendar span in days between two ISO dates (inclusive).
 * calendarSpan("2026-04-09", "2026-04-11") → 3
 */
function calendarSpan(first: string, last: string): number {
  const d1 = new Date(first);
  const d2 = new Date(last);
  return Math.round((d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}
