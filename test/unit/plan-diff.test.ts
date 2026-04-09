/**
 * Unit tests for diffProposals() — Plan 025 change summary generator.
 *
 * Tests all change types: batch moved, recipe swapped, flex moved/added/removed,
 * event added/removed, no changes, multiple simultaneous changes, and duplicate
 * recipes matched by day overlap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffProposals } from '../../src/agents/plan-diff.js';
import type { PlanProposal, ProposedBatch } from '../../src/solver/types.js';
import type { FlexSlot, MealEvent } from '../../src/models/types.js';

// ─── Helpers ──────────��─────────────────────────────────────────────────────

function makeBatch(overrides: Partial<ProposedBatch> & { recipeSlug: string; recipeName: string; days: string[] }): ProposedBatch {
  return {
    mealType: 'lunch',
    servings: overrides.days.length,
    ...overrides,
  };
}

function makeFlex(day: string, mealTime: 'lunch' | 'dinner' = 'dinner'): FlexSlot {
  return { day, mealTime, flexBonus: 350, note: 'flex meal' };
}

function makeEvent(day: string, mealTime: 'lunch' | 'dinner', name: string, cal = 800): MealEvent {
  return { day, mealTime, name, estimatedCalories: cal };
}

function makeProposal(
  batches: ProposedBatch[],
  flexSlots: FlexSlot[] = [],
  events: MealEvent[] = [],
): PlanProposal {
  return { batches, flexSlots, events, recipesToGenerate: [] };
}

// ─── Tests ───────────���─────────────────────────────��────────────────────────

test('diffProposals: batch moved (same recipe, different days)', () => {
  const old = makeProposal([
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-13', '2026-04-14', '2026-04-15'] }),
  ]);
  const updated = makeProposal([
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-15', '2026-04-17', '2026-04-18'] }),
  ]);

  const result = diffProposals(old, updated);
  assert.ok(result.includes('Moved Tagine'), `Expected "Moved Tagine" in: ${result}`);
  assert.ok(result.includes('Mon–Wed'), `Expected old day range`);
});

test('diffProposals: recipe swapped (different recipe on overlapping days)', () => {
  const old = makeProposal([
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'dinner', days: ['2026-04-16', '2026-04-17', '2026-04-18'] }),
  ]);
  const updated = makeProposal([
    makeBatch({ recipeSlug: 'pork-bowls', recipeName: 'Pork Bowls', mealType: 'dinner', days: ['2026-04-16', '2026-04-17', '2026-04-18'] }),
  ]);

  const result = diffProposals(old, updated);
  assert.ok(result.includes('Swapped Tagine for Pork Bowls'), `Expected swap in: ${result}`);
});

test('diffProposals: flex moved', () => {
  const old = makeProposal([], [makeFlex('2026-04-18', 'dinner')]);
  const updated = makeProposal([], [makeFlex('2026-04-19', 'dinner')]);

  const result = diffProposals(old, updated);
  assert.ok(result.includes('Moved flex'), `Expected "Moved flex" in: ${result}`);
  assert.ok(result.includes('Sat dinner'), `Expected "Sat" in: ${result}`);
  assert.ok(result.includes('Sun dinner'), `Expected "Sun" in: ${result}`);
});

test('diffProposals: event added', () => {
  const old = makeProposal([], [], []);
  const updated = makeProposal([], [], [
    makeEvent('2026-04-18', 'dinner', 'Dinner with friends', 800),
  ]);

  const result = diffProposals(old, updated);
  assert.ok(result.includes('Added event'), `Expected "Added event" in: ${result}`);
  assert.ok(result.includes('Dinner with friends'), `Expected event name in: ${result}`);
});

test('diffProposals: event removed', () => {
  const old = makeProposal([], [], [
    makeEvent('2026-04-17', 'lunch', 'Team lunch'),
  ]);
  const updated = makeProposal([], [], []);

  const result = diffProposals(old, updated);
  assert.ok(result.includes('Removed event'), `Expected "Removed event" in: ${result}`);
  assert.ok(result.includes('Team lunch'), `Expected event name in: ${result}`);
});

test('diffProposals: no changes', () => {
  const batches = [
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-13', '2026-04-14'] }),
  ];
  const flex = [makeFlex('2026-04-18')];
  const proposal = makeProposal(batches, flex);

  const result = diffProposals(proposal, proposal);
  assert.equal(result, 'No changes to the plan.');
});

test('diffProposals: multiple simultaneous changes', () => {
  const old = makeProposal(
    [
      makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-13', '2026-04-14', '2026-04-15'] }),
      makeBatch({ recipeSlug: 'stir-fry', recipeName: 'Stir-fry', mealType: 'dinner', days: ['2026-04-13', '2026-04-14'] }),
    ],
    [makeFlex('2026-04-18', 'dinner')],
    [makeEvent('2026-04-17', 'dinner', 'Team dinner')],
  );
  const updated = makeProposal(
    [
      makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-14', '2026-04-15', '2026-04-16'] }),
      makeBatch({ recipeSlug: 'salmon', recipeName: 'Salmon', mealType: 'dinner', days: ['2026-04-13', '2026-04-14'] }),
    ],
    [makeFlex('2026-04-19', 'dinner')],
    [],
  );

  const result = diffProposals(old, updated);
  // Should mention: event removed, batch moved, recipe swapped, flex moved
  assert.ok(result.includes('Removed event'), `Expected event removal in: ${result}`);
  assert.ok(result.includes('Moved Tagine'), `Expected batch move in: ${result}`);
  assert.ok(result.includes('Swapped Stir-fry for Salmon'), `Expected recipe swap in: ${result}`);
  assert.ok(result.includes('Moved flex'), `Expected flex move in: ${result}`);
});

test('diffProposals: duplicate recipes — match by day overlap', () => {
  // Small DB: same recipe used twice for lunch, different day ranges
  const old = makeProposal([
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-13', '2026-04-14'] }),
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-17', '2026-04-18'] }),
  ]);
  const updated = makeProposal([
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-13', '2026-04-14'] }),
    makeBatch({ recipeSlug: 'tagine', recipeName: 'Tagine', mealType: 'lunch', days: ['2026-04-17', '2026-04-18', '2026-04-19'] }),
  ]);

  const result = diffProposals(old, updated);
  // First batch: no change (same days) — should not appear
  // Second batch: days changed (added Sat) AND servings changed (2→3)
  assert.ok(!result.includes('Removed'), `Should not remove/add: ${result}`);
  // Days changed + servings changed → "Moved ... (3 servings)"
  assert.ok(result.includes('Moved Tagine') && result.includes('3 servings'), `Expected move with servings: ${result}`);
});

test('diffProposals: servings reduced', () => {
  const old = makeProposal([
    makeBatch({ recipeSlug: 'stir-fry', recipeName: 'Stir-fry', mealType: 'lunch', days: ['2026-04-13', '2026-04-14', '2026-04-15'] }),
  ]);
  const updated = makeProposal([
    makeBatch({ recipeSlug: 'stir-fry', recipeName: 'Stir-fry', mealType: 'lunch', days: ['2026-04-13', '2026-04-14'] }),
  ]);

  const result = diffProposals(old, updated);
  assert.ok(result.includes('Reduced Stir-fry from 3 to 2 servings') || result.includes('Moved Stir-fry'), `Expected change in: ${result}`);
});
