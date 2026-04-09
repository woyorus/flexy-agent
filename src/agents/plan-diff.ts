/**
 * Deterministic change summary generator for plan proposals.
 *
 * Compares an old and new PlanProposal and returns a human-readable summary
 * of what changed. Used after the re-proposer modifies a plan so the user
 * sees exactly what shifted before approving.
 *
 * Algorithm (two passes):
 *   Pass 1 — Match batches by recipe identity (mealType, recipeSlug).
 *            Disambiguate duplicates by day overlap.
 *   Pass 2 — Detect recipe swaps from unmatched pairs with overlapping days.
 *
 * Plan: docs/plans/active/025-re-proposer-agent-and-flow-simplification.md
 */

import type { PlanProposal, ProposedBatch } from '../solver/types.js';
import type { MealEvent, FlexSlot } from '../models/types.js';
import { formatDayRange } from '../plan/helpers.js';

/**
 * Generate a human-readable summary of changes between two plan proposals.
 *
 * @param oldProposal - The previous plan
 * @param newProposal - The updated plan
 * @returns Multi-line summary string describing all changes
 */
export function diffProposals(
  oldProposal: PlanProposal,
  newProposal: PlanProposal,
): string {
  const lines: string[] = [];

  // ─── Events ────────────────────────────────────────────────────────────────
  const eventChanges = diffEvents(oldProposal.events, newProposal.events);
  lines.push(...eventChanges);

  // ─── Batches ───────────────────────────────────────────────────────────────
  const batchChanges = diffBatches(oldProposal.batches, newProposal.batches);
  lines.push(...batchChanges);

  // ─── Flex slots ────────────────────────────────────────────────────────────
  const flexChanges = diffFlexSlots(oldProposal.flexSlots, newProposal.flexSlots);
  lines.push(...flexChanges);

  if (lines.length === 0) {
    return 'No changes to the plan.';
  }

  return lines.join('\n');
}

// ─── Batch diffing ──────────────────────────────────────────────────────────────

function diffBatches(oldBatches: ProposedBatch[], newBatches: ProposedBatch[]): string[] {
  const lines: string[] = [];
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();

  // Pass 1: Match by recipe identity (mealType + recipeSlug)
  // When multiple batches share the same key, pair by maximum day overlap.
  for (let oi = 0; oi < oldBatches.length; oi++) {
    if (matchedOld.has(oi)) continue;
    const ob = oldBatches[oi]!;

    let bestNewIdx = -1;
    let bestOverlap = -1;

    for (let ni = 0; ni < newBatches.length; ni++) {
      if (matchedNew.has(ni)) continue;
      const nb = newBatches[ni]!;

      if (ob.mealType === nb.mealType && ob.recipeSlug === nb.recipeSlug) {
        const overlap = dayOverlap(ob.days, nb.days);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestNewIdx = ni;
        }
      }
    }

    if (bestNewIdx >= 0) {
      matchedOld.add(oi);
      matchedNew.add(bestNewIdx);
      const nb = newBatches[bestNewIdx]!;

      // Same recipe — check what changed
      const daysChanged = !arraysEqual(ob.days, nb.days);
      const servingsChanged = ob.servings !== nb.servings;

      if (daysChanged && servingsChanged) {
        lines.push(`Moved ${ob.recipeName} from ${formatDayRange(ob.days)} to ${formatDayRange(nb.days)} (${nb.servings} servings)`);
      } else if (daysChanged) {
        lines.push(`Moved ${ob.recipeName} from ${formatDayRange(ob.days)} to ${formatDayRange(nb.days)}`);
      } else if (servingsChanged) {
        const verb = nb.servings > ob.servings ? 'Increased' : 'Reduced';
        lines.push(`${verb} ${ob.recipeName} from ${ob.servings} to ${nb.servings} servings (${formatDayRange(nb.days)})`);
      }
      // If nothing changed, don't add a line
    }
  }

  // Pass 2: Detect recipe swaps from unmatched pairs
  const unmatchedOld = oldBatches
    .map((b, i) => ({ batch: b, index: i }))
    .filter(({ index }) => !matchedOld.has(index));
  const unmatchedNew = newBatches
    .map((b, i) => ({ batch: b, index: i }))
    .filter(({ index }) => !matchedNew.has(index));

  const pairedOld = new Set<number>();
  const pairedNew = new Set<number>();

  for (const { batch: ob, index: oi } of unmatchedOld) {
    if (pairedOld.has(oi)) continue;

    let bestNewIdx = -1;
    let bestOverlap = -1;

    for (const { batch: nb, index: ni } of unmatchedNew) {
      if (pairedNew.has(ni)) continue;
      if (ob.mealType !== nb.mealType) continue;

      const overlap = dayOverlap(ob.days, nb.days);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestNewIdx = ni;
      }
    }

    if (bestNewIdx >= 0 && bestOverlap > 0) {
      pairedOld.add(oi);
      pairedNew.add(bestNewIdx);
      const nb = newBatches[bestNewIdx]!;
      lines.push(`Swapped ${ob.recipeName} for ${nb.recipeName} on ${formatDayRange(nb.days)}`);
    }
  }

  // Remaining unmatched old = removed
  for (const { batch: ob, index: oi } of unmatchedOld) {
    if (pairedOld.has(oi)) continue;
    lines.push(`Removed ${ob.recipeName} (${formatDayRange(ob.days)})`);
  }

  // Remaining unmatched new = added
  for (const { batch: nb, index: ni } of unmatchedNew) {
    if (pairedNew.has(ni)) continue;
    lines.push(`Added ${nb.recipeName} on ${formatDayRange(nb.days)} (${nb.servings} servings)`);
  }

  return lines;
}

// ─── Flex slot diffing ──────────────────────────────────────────────────────────

function diffFlexSlots(oldFlex: FlexSlot[], newFlex: FlexSlot[]): string[] {
  const lines: string[] = [];
  const oldKeys = new Set(oldFlex.map(f => `${f.day}:${f.mealTime}`));
  const newKeys = new Set(newFlex.map(f => `${f.day}:${f.mealTime}`));

  const removed = oldFlex.filter(f => !newKeys.has(`${f.day}:${f.mealTime}`));
  const added = newFlex.filter(f => !oldKeys.has(`${f.day}:${f.mealTime}`));

  if (removed.length === 1 && added.length === 1) {
    // Flex moved
    const r = removed[0]!;
    const a = added[0]!;
    lines.push(`Moved flex from ${formatDayShort(r.day)} ${r.mealTime} to ${formatDayShort(a.day)} ${a.mealTime}`);
  } else {
    for (const r of removed) {
      lines.push(`Removed flex on ${formatDayShort(r.day)} ${r.mealTime}`);
    }
    for (const a of added) {
      lines.push(`Added flex on ${formatDayShort(a.day)} ${a.mealTime}`);
    }
  }

  return lines;
}

// ─── Event diffing ──────────────────────────────────────────────────────────────

function diffEvents(oldEvents: MealEvent[], newEvents: MealEvent[]): string[] {
  const lines: string[] = [];
  const oldKeys = new Map(oldEvents.map(e => [`${e.day}:${e.mealTime}`, e]));
  const newKeys = new Map(newEvents.map(e => [`${e.day}:${e.mealTime}`, e]));

  // Removed events
  for (const [key, e] of oldKeys) {
    if (!newKeys.has(key)) {
      lines.push(`Removed event: ${e.name} on ${formatDayShort(e.day)} ${e.mealTime}`);
    }
  }

  // Added events
  for (const [key, e] of newKeys) {
    if (!oldKeys.has(key)) {
      lines.push(`Added event: ${e.name} on ${formatDayShort(e.day)} ${e.mealTime} (~${e.estimatedCalories} cal)`);
    }
  }

  return lines;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function dayOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter(d => setB.has(d)).length;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function formatDayShort(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}
